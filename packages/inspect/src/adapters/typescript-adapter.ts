import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanOptions,
  Issue,
  IssueCategory,
  AccessScope,
} from '@zh/shared';
import { detectMachineProfile } from '@zh/shared';
import {
  asToolExecError,
  buildAccessScope,
  buildToolResult,
  execTool,
  ToolCommandResolver,
} from './tool-runner';

const META: Omit<ToolMeta, 'description'> = {
  id: 'tsc',
  name: 'TypeScript',
  category: 'inspect',
  priority: 'P0',
  installMode: 'builtin',
  cliCommand: 'tsc',
  homepage: 'https://www.typescriptlang.org',
  license: 'Apache-2.0',
};

/** tsc 诊断行: /abs/path.ts(12,5): error TS2322: message */
const TS_DIAG_LINE = /^(.+?)\((\d+)(?:,(\d+))?\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

/** 解析 tsc stderr 中的类型错误为 Issue 列表（纯函数，便于单测） */
export function parseTscDiagnostics(
  raw: string,
  category: IssueCategory = 'quality',
  locale?: LanguageCode,
): Issue[] {
  if (!raw) return [];
  const lng = locale ?? DEFAULT_LANGUAGE;
  const issues: Issue[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(TS_DIAG_LINE);
    if (!match) continue;
    const [, file, lineStr, colStr, level, code, message] = match;
    issues.push({
      id: randomUUID(),
      ruleId: `tsc/${code}`,
      severity: level === 'error' ? 'error' : 'warning',
      category,
      message: `${message} (${code})`,
      file,
      line: parseInt(lineStr, 10) || 0,
      column: colStr ? parseInt(colStr, 10) || 0 : 0,
      suggestion: translate('engine.inspect.tool.tsc.fixSuggestion', lng, { level, code }),
      autoFixable: false,
      source: 'inspect',
      fingerprint: `tsc:${code}:${file}:${lineStr}`,
    });
  }
  return issues;
}

function hasTsconfig(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'tsconfig.json'));
}

function listPackageTsconfigs(packagesDir: string): string[] {
  try {
    return fs
      .readdirSync(packagesDir)
      .filter((d) => d !== 'node_modules' && fs.statSync(path.join(packagesDir, d)).isDirectory())
      .map((d) => path.join(packagesDir, d, 'tsconfig.json'))
      .filter((p) => fs.existsSync(p));
  } catch {
    return [];
  }
}

/** 解析应检查的 tsconfig 列表：monorepo 根（tsconfig + packages/）→ 逐包；否则单项目；嵌套仓库按一层子目录探测 */
export function resolveTscProjects(projectPath: string): string[] {
  if (hasTsconfig(projectPath)) {
    const packagesDir = path.join(projectPath, 'packages');
    if (fs.existsSync(packagesDir)) {
      return listPackageTsconfigs(packagesDir);
    }
    return [path.join(projectPath, 'tsconfig.json')];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(projectPath);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const child = path.join(projectPath, entry);
    try {
      if (!fs.statSync(child).isDirectory() || !hasTsconfig(child)) continue;
      const packagesDir = path.join(child, 'packages');
      if (fs.existsSync(packagesDir)) {
        return listPackageTsconfigs(packagesDir);
      }
      return [path.join(child, 'tsconfig.json')];
    } catch {
      // 忽略损坏的符号链接 / 无权限目录
    }
  }
  return [];
}

interface TscRunResult {
  issues: Issue[];
  infraError?: string;
}

/** TypeScriptAdapter.runAllProjects 的执行参数 */
interface RunAllProjectsParams {
  command: string;
  projects: string[];
  flags: string[];
  options: ToolScanOptions;
  category: IssueCategory;
}

/** TypeScriptAdapter.runTsc 的执行参数 */
interface RunTscParams {
  command: string;
  tsconfigPath: string;
  flags: string[];
  options: ToolScanOptions;
  category: IssueCategory;
}

export class TypeScriptAdapter implements ToolAdapter {
  meta: ToolMeta;
  private readonly commands: ToolCommandResolver;
  private readonly locale: LanguageCode;

  /** F5：tsc 按 tsconfig 编译检查全部 TS 源文件 */
  readonly accessScope: AccessScope = buildAccessScope(['**/*.{ts,tsx,mts,cts}', '**/tsconfig.json']);

  constructor(projectRoot?: string, locale?: LanguageCode) {
    this.commands = new ToolCommandResolver('tsc', projectRoot);
    this.locale = locale ?? DEFAULT_LANGUAGE;
    this.meta = {
      ...META,
      description: translate('engine.inspect.tool.tsc.description', this.locale),
    };
  }

  private tr(key: string, params?: Record<string, unknown>): string {
    return translate(key, this.locale, params);
  }

  async isAvailable(): Promise<boolean> {
    return this.commands.isAvailable();
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const category: IssueCategory = options.config?.category ?? 'quality';

    try {
      return await this.runTscScan(options, start, category);
    } catch (error: unknown) {
      return this.buildResult(
        start,
        category,
        [],
        (error as Error).message || this.tr('engine.inspect.tool.tsc.runFailed'),
      );
    }
  }

  /** 解析项目并逐个运行 tsc，聚合结果 */
  private async runTscScan(
    options: ToolScanOptions,
    start: number,
    category: IssueCategory,
  ): Promise<ToolResult> {
    // 归一化 projectPath 为绝对路径：相对路径会流入 tsconfig 解析与 cwd，
    // tsc 以自身 cwd 解析相对路径导致扫描失败。
    const projectPath = path.resolve(options.projectPath);
    const command = await this.commands.resolve(projectPath);
    const projects = resolveTscProjects(projectPath);
    if (projects.length === 0) {
      // 非 TypeScript 项目：无 tsconfig 可检查，按通过处理（不阻断）
      return this.buildResult(start, category, []);
    }
    const flags = this.buildFlags(options);
    const { issues, infraError } = await this.runAllProjects({
      command,
      projects,
      flags,
      options,
      category,
    });
    if (infraError && issues.length === 0) {
      return this.buildResult(start, category, [], infraError);
    }
    return this.buildResult(start, category, issues);
  }

  /** 有界并发运行各 tsconfig 的 tsc 并聚合 issues 与首个基础设施错误 */
  private async runAllProjects(params: RunAllProjectsParams): Promise<{
    issues: Issue[];
    infraError?: string;
  }> {
    const { command, projects, flags, options, category } = params;
    // 串行跑 20 包约 92-116s，会撞 120s 硬上限；复用机器画像并发度（2-4）有界并行
    const concurrency = Math.min(detectMachineProfile().adapterParallelism, projects.length);
    const results: TscRunResult[] = new Array(projects.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= projects.length) break;
        results[index] = await this.runTsc({
          command,
          tsconfigPath: projects[index],
          flags,
          options,
          category,
        });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const issues: Issue[] = [];
    let infraError: string | undefined;
    for (const one of results) {
      issues.push(...one.issues);
      if (one.infraError && !infraError) infraError = one.infraError;
    }
    return { issues, infraError };
  }

  private buildFlags(options: ToolScanOptions): string[] {
    const flags = [...(options.config?.flags ?? [])];
    if (!flags.includes('--noEmit')) flags.unshift('--noEmit');
    // tsc 只接受 `--composite false` 空格形式，`--composite=false` 会报 TS5023 未知选项
    if (!flags.includes('--composite')) flags.push('--composite', 'false');
    return flags;
  }

  private async runTsc(params: RunTscParams): Promise<TscRunResult> {
    const { command, tsconfigPath, flags, options, category } = params;
    try {
      const { stdout } = await execTool(command, [...flags, '-p', tsconfigPath], {
        cwd: path.resolve(options.projectPath),
        timeout: options.timeout || 120000,
      });
      return { issues: parseTscDiagnostics(stdout, category) };
    } catch (error: unknown) {
      const err = asToolExecError(error);
      if (err.code === 'ENOENT') {
        return { issues: [], infraError: this.tr('engine.inspect.tool.tsc.unavailable') };
      }
      // 非 TTY 下 tsc 诊断输出到 stdout，报错场景需同时解析两个流
      const raw = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
      const issues = parseTscDiagnostics(raw, category, this.locale);
      if (issues.length > 0) {
        return { issues };
      }
      return {
        issues: [],
        infraError: err.message || this.tr('engine.inspect.tool.tsc.runFailed'),
      };
    }
  }

  private buildResult(
    start: number,
    category: IssueCategory,
    issues: Issue[],
    error?: string,
  ): ToolResult {
    const infraFailed = !!error && issues.length === 0;
    return buildToolResult({
      tool: 'tsc',
      status: infraFailed ? 'error' : 'available',
      issues,
      start,
      error,
    });
  }
}
