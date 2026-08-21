import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue, IssueCategory } from '@zh/shared';
import { resolveToolCommand } from './tool-bin';

const execFileAsync = promisify(execFile);

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
    return fs.readdirSync(packagesDir)
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

  let entries: string[] = [];
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

export class TypeScriptAdapter implements ToolAdapter {
  meta: ToolMeta;
  private projectRoot?: string;
  private commandPromise?: Promise<string>;
  private readonly locale: LanguageCode;

  constructor(projectRoot?: string, locale?: LanguageCode) {
    this.projectRoot = projectRoot;
    this.locale = locale ?? DEFAULT_LANGUAGE;
    this.meta = { ...META, description: translate('engine.inspect.tool.tsc.description', this.locale) };
  }

  private tr(key: string, params?: Record<string, unknown>): string {
    return translate(key, this.locale, params);
  }

  private resolveCommand(): Promise<string> {
    if (!this.commandPromise) {
      this.commandPromise = resolveToolCommand('tsc', this.projectRoot);
    }
    return this.commandPromise;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const command = await this.resolveCommand();
      const { stdout } = await execFileAsync(command, ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const category: IssueCategory = options.config?.category ?? 'quality';

    try {
      const command = await this.resolveCommand();
      const projects = resolveTscProjects(options.projectPath);
      if (projects.length === 0) {
        // 非 TypeScript 项目：无 tsconfig 可检查，按通过处理（不阻断）
        return this.buildResult(start, category, []);
      }

      const flags = this.buildFlags(options);
      const issues: Issue[] = [];
      let infraError: string | undefined;
      for (const tsconfig of projects) {
        const one = await this.runTsc(command, tsconfig, flags, options, category);
        issues.push(...one.issues);
        if (one.infraError && !infraError) infraError = one.infraError;
      }
      if (infraError && issues.length === 0) {
        return this.buildResult(start, category, [], infraError);
      }
      return this.buildResult(start, category, issues);
    } catch (error: unknown) {
      return this.buildResult(start, category, [], (error as Error).message || this.tr('engine.inspect.tool.tsc.runFailed'));
    }
  }

  private buildFlags(options: ToolScanOptions): string[] {
    const flags = [...(options.config?.flags ?? [])];
    if (!flags.includes('--noEmit')) flags.unshift('--noEmit');
    // tsc 只接受 `--composite false` 空格形式，`--composite=false` 会报 TS5023 未知选项
    if (!flags.includes('--composite')) flags.push('--composite', 'false');
    return flags;
  }

  private async runTsc(
    command: string,
    tsconfigPath: string,
    flags: string[],
    options: ToolScanOptions,
    category: IssueCategory,
  ): Promise<TscRunResult> {
    try {
      const { stdout } = await execFileAsync(command, [...flags, '-p', tsconfigPath], {
        cwd: options.projectPath,
        timeout: options.timeout || 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { issues: parseTscDiagnostics(stdout, category) };
    } catch (error: unknown) {
      const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
      if (err.code === 'ENOENT') {
        return { issues: [], infraError: this.tr('engine.inspect.tool.tsc.unavailable') };
      }
      // 非 TTY 下 tsc 诊断输出到 stdout，报错场景需同时解析两个流
      const raw = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
      const issues = parseTscDiagnostics(raw, category, this.locale);
      if (issues.length > 0) {
        return { issues };
      }
      return { issues: [], infraError: err.message || this.tr('engine.inspect.tool.tsc.runFailed') };
    }
  }

  private buildResult(start: number, category: IssueCategory, issues: Issue[], error?: string): ToolResult {
    const infraFailed = !!error && issues.length === 0;
    return {
      tool: 'tsc',
      status: infraFailed ? 'error' : 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: issues.length,
      },
      ...(error ? { error } : {}),
    };
  }
}
