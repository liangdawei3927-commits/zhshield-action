import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue, IssueCategory } from '@zh/shared';
import { resolveToolCommand } from './tool-bin';

const execFileAsync = promisify(execFile);

const ESLINT_CONFIG_NAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc',
] as const;

function hasEslintConfig(dir: string): boolean {
  return ESLINT_CONFIG_NAMES.some((name) => fs.existsSync(path.join(dir, name)));
}

/** ESLint JSON 输出中的单条消息 */
interface EslintOutputMessage {
  ruleId?: string;
  message?: string;
  line?: number;
  column?: number;
  severity?: number;
  fix?: unknown;
}

/** ESLint JSON 输出中的单个文件项 */
interface EslintOutputFile {
  filePath?: string;
  messages?: EslintOutputMessage[];
}

/**
 * 探测 ESLint 应扫描的目录（ESLint v9 从 cwd 向上查找配置）：
 * 1. 项目根含 eslint 配置 → 项目根
 * 2. 一层子目录含 eslint 配置（嵌套仓库，如 zhiyan-codeshield/）→ 该子目录
 * 3. 有 src / packages → 对应源码目录
 * 4. 兜底项目根
 */
function resolveEslintTargetDir(projectPath: string): string {
  if (hasEslintConfig(projectPath)) return projectPath;

  const entries = fs.existsSync(projectPath) ? fs.readdirSync(projectPath) : [];
  for (const entry of entries) {
    const child = path.join(projectPath, entry);
    try {
      if (fs.statSync(child).isDirectory() && hasEslintConfig(child)) return child;
    } catch {
      // 忽略损坏的符号链接 / 无权限目录
    }
  }

  for (const candidate of ['src', 'packages']) {
    const dir = path.join(projectPath, candidate);
    if (fs.existsSync(dir)) return dir;
  }
  return projectPath;
}

const META: Omit<ToolMeta, 'description'> = {
  id: 'eslint',
  name: 'ESLint',
  category: 'inspect',
  priority: 'P0',
  installMode: 'builtin',
  cliCommand: 'eslint',
  homepage: 'https://eslint.org',
  license: 'MIT',
};

export class ESLintAdapter implements ToolAdapter {
  meta: ToolMeta;
  private projectRoot?: string;
  private commandPromise?: Promise<string>;
  private readonly locale: LanguageCode;

  constructor(projectRoot?: string, locale?: LanguageCode) {
    this.projectRoot = projectRoot;
    this.locale = locale ?? DEFAULT_LANGUAGE;
    this.meta = { ...META, description: translate('engine.inspect.tool.eslint.description', this.locale) };
  }

  private tr(key: string, params?: Record<string, unknown>): string {
    return translate(key, this.locale, params);
  }

  private resolveCommand(): Promise<string> {
    if (!this.commandPromise) {
      this.commandPromise = resolveToolCommand('eslint', this.projectRoot);
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
    const targetDir = resolveEslintTargetDir(options.projectPath);
    const category: IssueCategory = options.config?.category ?? 'quality';

    try {
      return await this.completeScan(options, targetDir, category, start);
    } catch (error: unknown) {
      return this.buildScanError(start, category, error);
    }
  }

  private async completeScan(
    options: ToolScanOptions,
    targetDir: string,
    category: IssueCategory,
    start: number,
  ): Promise<ToolResult> {
    const { cwd, args } = this.prepareScan(options, targetDir);
    const stdout = await this.runEslint(args, cwd, options);

    const rawOutput = JSON.parse(stdout);
    const issues = this.mapOutput(rawOutput, category);

    return this.buildAvailable(start, rawOutput, issues);
  }

  private prepareScan(options: ToolScanOptions, targetDir: string): { cwd: string; args: string[] } {
    const targetFiles = options.targetFiles || [targetDir];
    // ESLint v9 从 cwd 向上查找配置：默认扫描时以解析出的目录为 cwd，确保找到嵌套仓库的配置
    const cwd = options.targetFiles?.length ? options.projectPath : targetDir;
    const args = this.buildScanArgs(options, targetFiles, cwd);
    return { cwd, args };
  }

  private buildScanArgs(options: ToolScanOptions, targetFiles: string[], cwd: string): string[] {
    // ESLint v9 base-path 校验：绝对 target 在 config 文件目录之外会被静默忽略，故转相对路径
    const relativeTargets = targetFiles.map((target) => path.relative(cwd, target) || '.');
    const args: string[] = ['--format', 'json', '--ext', '.ts,.tsx,.js,.jsx', ...relativeTargets];
    this.applyEslintConfig(args, options.config?.config);
    return args;
  }

  private applyEslintConfig(args: string[], config: unknown): void {
    if (config) {
      // ESLint v9 中 --no-eslintrc 已移除；--config 指定 flat config 即不再查找其他配置
      args.unshift('--config', config as string);
    }
  }

  private async runEslint(args: string[], cwd: string, options: ToolScanOptions): Promise<string> {
    const command = await this.resolveCommand();
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  private buildScanError(start: number, category: IssueCategory, error: unknown): ToolResult {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return this.buildUnavailable(start, this.tr('engine.inspect.tool.eslint.unavailable'));
    }

    const rawOutput = this.parsePartialOutput(err.stdout ?? '');
    if (rawOutput) {
      return this.buildAvailable(start, rawOutput, this.mapOutput(rawOutput, category));
    }

    return this.buildError(start, err.stderr || err.message || this.tr('engine.inspect.tool.eslint.runFailed'));
  }

  private parsePartialOutput(stdout: string): unknown | null {
    if (!stdout) return null;
    try {
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  }

  private buildAvailable(start: number, rawOutput: unknown, issues: Issue[]): ToolResult {
    return {
      tool: 'eslint',
      status: 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: Array.isArray(rawOutput) ? rawOutput.length : 0,
      },
    };
  }

  private buildUnavailable(start: number, error: string): ToolResult {
    return {
      tool: 'eslint',
      status: 'unavailable',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private buildError(start: number, error: string): ToolResult {
    return {
      tool: 'eslint',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private mapOutput(output: unknown, category: IssueCategory = 'quality'): Issue[] {
    if (!Array.isArray(output)) return [];
    const issues: Issue[] = [];
    const files = output as EslintOutputFile[];
    for (const file of files) {
      if (!file?.messages || !Array.isArray(file.messages)) continue;
      for (const msg of file.messages) {
        if (!msg.ruleId) continue;
        issues.push(this.mapEslintMessage(msg, file, category));
      }
    }
    return issues;
  }

  private mapEslintMessage(msg: EslintOutputMessage, file: EslintOutputFile, category: IssueCategory): Issue {
    return {
      id: randomUUID(),
      ruleId: msg.ruleId as string,
      severity: msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info',
      category,
      message: msg.message || `ESLint: ${msg.ruleId}`,
      file: file.filePath || '',
      line: msg.line || 0,
      column: msg.column || 0,
      suggestion: msg.fix ? this.tr('engine.inspect.tool.eslint.autoFixable') : undefined,
      autoFixable: !!msg.fix,
      source: 'inspect',
      fingerprint: `${msg.ruleId}:${file.filePath || ''}:${msg.line || 0}`,
    };
  }
}
