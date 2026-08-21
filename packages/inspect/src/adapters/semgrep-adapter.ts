import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue, IssueCategory } from '@zh/shared';
import { SemgrepRuleWriter } from './semgrep-rule-writer';
import { SemgrepResultMapper, type SemgrepOutput } from './semgrep-result-mapper';

const execFileAsync = promisify(execFile);

/** OCaml 运行时无害告警：部分 macOS 环境下 semgrep-core 每次启动都会打印，不影响扫描结果 */
const OCAML_RUNTIME_NOISE = /Failed to register (segfault signal handler|unwind handler for some critical signals)/;

function stripRuntimeNoise(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !OCAML_RUNTIME_NOISE.test(line))
    .join('\n')
    .trim();
}

const META: Omit<ToolMeta, 'description'> = {
  id: 'semgrep',
  name: 'Semgrep',
  category: 'inspect',
  priority: 'P0',
  installMode: 'builtin',
  cliCommand: 'semgrep',
  homepage: 'https://semgrep.dev',
  license: 'LGPL-2.1',
};

/**
 * SemgrepAdapter — Semgrep SAST 扫描器适配器
 *
 * 职责：扫描编排、参数构建、结果包装
 * 内联规则写入见 SemgrepRuleWriter，JSON 输出映射见 SemgrepResultMapper
 */
export class SemgrepAdapter implements ToolAdapter {
  meta: ToolMeta;
  private readonly locale: LanguageCode;
  private ruleWriter = new SemgrepRuleWriter();
  private resultMapper = new SemgrepResultMapper();

  constructor(locale?: LanguageCode) {
    this.locale = locale ?? DEFAULT_LANGUAGE;
    this.meta = { ...META, description: translate('engine.inspect.tool.semgrep.description', this.locale) };
  }

  private tr(key: string, params?: Record<string, unknown>): string {
    return translate(key, this.locale, params);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('semgrep', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const targetDir = options.targetFiles?.[0] || this.resolveTargetDir(options.projectPath);
    const category: IssueCategory = options.config?.category ?? 'security';

    try {
      const args = await this.buildScanArgs(options, targetDir);
      const stdout = await this.runSemgrep(options, args);

      const output = JSON.parse(stdout);
      return this.buildAvailable(output, this.resultMapper.mapOutput(output, category), start);
    } catch (error: unknown) {
      return this.buildScanError(start, category, error);
    }
  }

  private async buildScanArgs(options: ToolScanOptions, targetDir: string): Promise<string[]> {
    const args = this.buildBaseArgs(options);

    const rulePath = await this.ruleWriter.writeInlineRuleConfig(options, targetDir);
    if (rulePath) args.push('--config', rulePath);

    args.push(targetDir);
    return args;
  }

  /**
   * 解析扫描目标目录：无显式 targetFiles 时按 src → packages → 嵌套代码仓库 依次取存在的目录。
   * 容器根项目（代码在子仓库中，如 zhiyan-codeshield/）直接扫全量会超时，
   * 需下探到嵌套仓库的源码目录，避免 "Invalid scanning root" / 扫描超时导致整规则失败
   */
  private resolveTargetDir(projectPath: string): string {
    for (const candidate of ['src', 'packages']) {
      const dir = path.join(projectPath, candidate);
      if (fs.existsSync(dir)) return dir;
    }
    const nested = this.findNestedRepo(projectPath);
    if (nested) return this.resolveTargetDir(nested);
    return projectPath;
  }

  /** 项目根下含 package.json 或 .git 的子目录（嵌套代码仓库），忽略隐藏目录 */
  private findNestedRepo(projectPath: string): string | null {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(projectPath, entry.name);
      if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, '.git'))) {
        return dir;
      }
    }
    return null;
  }

  private buildBaseArgs(options: ToolScanOptions): string[] {
    const configs = this.resolveConfigs(options);
    const args: string[] = [
      'scan',
      '--json',
      '--optimizations', 'all',
    ];

    for (const c of configs) {
      args.push('--config', c);
    }

    return args;
  }

  private async runSemgrep(options: ToolScanOptions, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('semgrep', args, {
      cwd: options.projectPath,
      timeout: options.timeout || 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  private buildScanError(start: number, category: IssueCategory, error: unknown): ToolResult {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return this.buildUnavailable(start, this.tr('engine.inspect.tool.semgrep.unavailable'));
    }
    if (err.code === 'ETIMEDOUT') {
      return this.buildError(start, this.tr('engine.inspect.tool.semgrep.timeout'));
    }

    // semgrep 存在 findings 时退出码为 1；stdout 仍为有效 JSON
    const partial = this.parsePartialOutput(err.stdout ?? '', category, err.stderr);
    if (partial) {
      return this.buildAvailable(partial.output, partial.issues, start);
    }

    // 退出码非 0 时优先取 semgrep JSON 输出 errors 字段中的真实错误（如 "Invalid scanning root"），
    // 避免把 OCaml 运行时启动告警（每次运行都会打印的无害噪音）误报为工具错误
    const realError = this.extractSemgrepError(err.stdout ?? '');
    if (realError) {
      return this.buildError(start, realError);
    }

    const stderr = stripRuntimeNoise(err.stderr ?? '');
    return this.buildError(start, stderr || err.message || this.tr('engine.inspect.tool.semgrep.runFailed'));
  }

  private extractSemgrepError(stdout: string): string | null {
    if (!stdout) return null;
    try {
      const output = JSON.parse(stdout) as SemgrepOutput;
      const messages = (output.errors ?? [])
        .map((e) => e?.message)
        .filter((m): m is string => typeof m === 'string' && m.length > 0);
      return messages.length > 0 ? messages[0] : null;
    } catch {
      return null;
    }
  }

  private parsePartialOutput(
    stdout: string,
    category: IssueCategory,
    stderr?: string,
  ): { output: SemgrepOutput; issues: Issue[] } | null {
    if (!stdout) return null;
    try {
      const output = JSON.parse(stdout);
      const issues = this.resultMapper.mapOutput(output, category);
      if (issues.length > 0 || !stderr) {
        return { output, issues };
      }
    } catch {
      return null;
    }
    return null;
  }

  private buildAvailable(output: SemgrepOutput, issues: Issue[], start: number): ToolResult {
    return {
      tool: 'semgrep',
      status: 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: Array.isArray(output.results) ? output.results.length : 0,
      },
    };
  }

  private buildUnavailable(start: number, error: string): ToolResult {
    return {
      tool: 'semgrep',
      status: 'unavailable',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private buildError(start: number, error: string): ToolResult {
    return {
      tool: 'semgrep',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private resolveConfigs(options: ToolScanOptions): string[] {
    const cfgs = options.config?.config;
    if (!cfgs) return [];
    if (Array.isArray(cfgs)) return cfgs as string[];
    if (typeof cfgs === 'string') return [this.resolveConfigPath(cfgs, options.projectPath)];
    return [];
  }

  private resolveConfigPath(configPath: string, projectPath: string): string {
    const absolutePath = path.resolve(projectPath, configPath);
    if (fs.existsSync(absolutePath)) return absolutePath;

    const monorepoRoot = path.resolve(projectPath, '../..');
    const monorepoPath = path.resolve(monorepoRoot, configPath);
    if (fs.existsSync(monorepoPath)) return monorepoPath;

    return configPath;
  }
}
