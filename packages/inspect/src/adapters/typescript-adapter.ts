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
  type ToolResultStatus,
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

/**
 * 纯模块/全局解析错误：依赖未安装或 @types 缺失时由 tsc 批量产出（TS2307 找不到模块、
 * TS2580 找不到全局名如 require/process）。它们是环境/安装问题，**不是用户代码缺陷**，
 * 绝不该作为门禁阻断依据——否则"clone 后未 npm install"就会被满屏假错误拦死。
 */
const RESOLUTION_ERROR_CODES = new Set(['TS2307', 'TS2580']);

/** 从 ruleId（`tsc/TSxxxx`）提取错误码 */
function tscErrorCode(ruleId: string): string {
  return ruleId.split('/')[1] ?? '';
}

/** 判断一条 tsc 诊断是否为环境/安装类解析错误（依赖缺失、全局类型缺失） */
function isResolutionError(ruleId: string): boolean {
  return RESOLUTION_ERROR_CODES.has(tscErrorCode(ruleId));
}

/** 判断一条 tsc 诊断是否落在 node_modules 内（第三方代码，绝不应算作用户缺陷） */
function isInNodeModules(file: string, projectPath: string): boolean {
  const nm = path.join(projectPath, 'node_modules');
  return file === nm || file.startsWith(nm + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`);
}

/**
 * 把 tsc 诊断拆分为「用户源码真错误」与「环境/安装类伪影」。
 * 伪影 = 落在 node_modules 内的诊断 + 纯解析错误（TS2307/TS2580）。
 * 门禁只认前者；后者说明检查无法给出可信结论，应降级而非阻断。
 */
export function splitTscIssues(all: Issue[], projectPath: string): { issues: Issue[]; envArtifactCount: number } {
  const issues: Issue[] = [];
  let envArtifactCount = 0;
  for (const issue of all) {
    if (isInNodeModules(issue.file, projectPath) || isResolutionError(issue.ruleId)) {
      envArtifactCount++;
    } else {
      issues.push(issue);
    }
  }
  return { issues, envArtifactCount };
}

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
  /** 环境/安装类伪影数（node_modules 内报错 + TS2307/TS2580 解析失败）。>0 且用户源码 0 错误 ⇒ 检查无法给出确定结论，应降级 */
  envArtifactCount: number;
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
    const projects = resolveTscProjects(projectPath);
    if (projects.length === 0) {
      // 非 TypeScript 项目：无 tsconfig 可检查，按通过处理（不阻断）
      return this.buildResult(start, category, []);
    }
    // 依赖未安装（node_modules 缺失）→ 类型检查无法给出可信结论。
    // 此时 tsc 会对每个 import 报 TS2307，门禁若据此阻断就等于"clone 后未安装依赖就被拦死"——
    // 属环境/安装问题，必须降级为未执行，绝不阻断。
    if (!fs.existsSync(path.join(projectPath, 'node_modules'))) {
      return this.buildResult(
        start,
        category,
        [],
        this.tr('engine.inspect.tool.tsc.depsMissing'),
        'unavailable',
      );
    }
    const command = await this.commands.resolve(projectPath);
    const flags = this.buildFlags(options);
    const { issues, envArtifactCount, infraError } = await this.runAllProjects({
      command,
      projects,
      flags,
      options,
      category,
    });
    // 真有用户源码类型错误 ⇒ 如实上报（门禁据此合理阻断）
    if (issues.length > 0) {
      return this.buildResult(start, category, issues);
    }
    // tsc 自身崩溃（无诊断输出）⇒ 执行错误
    if (infraError) {
      return this.buildResult(start, category, [], infraError);
    }
    // 只产出环境/安装类伪影（node_modules 报错、模块解析失败）⇒ 无法给出确定结论，降级而非阻断
    if (envArtifactCount > 0) {
      return this.buildResult(
        start,
        category,
        [],
        this.tr('engine.inspect.tool.tsc.unresolvedEnv'),
        'unavailable',
      );
    }
    // 干净：零错误
    return this.buildResult(start, category, []);
  }

  /** 有界并发运行各 tsconfig 的 tsc 并聚合 issues / 环境伪影数 / 首个基础设施错误 */
  private async runAllProjects(params: RunAllProjectsParams): Promise<{
    issues: Issue[];
    envArtifactCount: number;
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
    let envArtifactCount = 0;
    let infraError: string | undefined;
    for (const one of results) {
      issues.push(...one.issues);
      envArtifactCount += one.envArtifactCount;
      if (one.infraError && !infraError) infraError = one.infraError;
    }
    return { issues, envArtifactCount, infraError };
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
    const projectPath = path.resolve(options.projectPath);
    try {
      const { stdout } = await execTool(command, [...flags, '-p', tsconfigPath], {
        cwd: projectPath,
        timeout: options.timeout || 300000,
      });
      const { issues, envArtifactCount } = splitTscIssues(
        parseTscDiagnostics(stdout, category),
        projectPath,
      );
      return { issues, envArtifactCount };
    } catch (error: unknown) {
      const err = asToolExecError(error);
      if (err.code === 'ENOENT') {
        return { issues: [], envArtifactCount: 0, infraError: this.tr('engine.inspect.tool.tsc.unavailable') };
      }
      // 非 TTY 下 tsc 诊断输出到 stdout，报错场景需同时解析两个流
      const raw = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
      const parsed = parseTscDiagnostics(raw, category, this.locale);
      if (parsed.length > 0) {
        const { issues, envArtifactCount } = splitTscIssues(parsed, projectPath);
        // 仍有用户源码真错误 ⇒ 上报；只剩环境伪影 ⇒ 不报 findings（由 runTscScan 统一降级）
        return { issues, envArtifactCount };
      }
      return {
        issues: [],
        envArtifactCount: 0,
        infraError: err.message || this.tr('engine.inspect.tool.tsc.runFailed'),
      };
    }
  }

  private buildResult(
    start: number,
    category: IssueCategory,
    issues: Issue[],
    error?: string,
    statusOverride?: ToolResultStatus,
  ): ToolResult {
    const status = statusOverride ?? (error && issues.length === 0 ? 'error' : 'available');
    return buildToolResult({
      tool: 'tsc',
      status,
      issues,
      start,
      error,
    });
  }
}
