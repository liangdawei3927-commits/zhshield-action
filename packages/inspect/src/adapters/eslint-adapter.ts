import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue, IssueCategory, AccessScope } from '@zh/shared';
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

const META: ToolMeta = {
  id: 'eslint',
  name: 'ESLint',
  category: 'inspect',
  priority: 'P0',
  installMode: 'builtin',
  description: 'JS/TS 代码规范与质量检查',
  cliCommand: 'eslint',
  homepage: 'https://eslint.org',
  license: 'MIT',
};

export class ESLintAdapter implements ToolAdapter {
  meta = META;
  private commandPromise?: Promise<string>;
  private readonly projectRoot?: string;

  /** F5：ESLint 以 --ext .ts/.tsx/.js/.jsx 扫描 JS/TS 源码 */
  readonly accessScope: AccessScope = {
    readPaths: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    excludePaths: ['**/node_modules/**'],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
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
    const defaultTarget = resolveEslintTargetDir(options.projectPath);
    const targetFiles = options.targetFiles || [defaultTarget];
    // ESLint v9 从 cwd 向上查找配置：默认扫描时以解析出的目录为 cwd，确保找到嵌套仓库的配置
    const cwd = options.targetFiles?.length ? options.projectPath : defaultTarget;
    const category: IssueCategory = options.config?.category ?? 'quality';

    try {
      return await this.runEslintScan(options, start, category, cwd, targetFiles);
    } catch (error: unknown) {
      return this.handleEslintError(error, start, category);
    }
  }

  /** 执行 ESLint 扫描并映射输出为可用结果 */
  private async runEslintScan(
    options: ToolScanOptions,
    start: number,
    category: IssueCategory,
    cwd: string,
    targetFiles: string[],
  ): Promise<ToolResult> {
    const command = await this.resolveCommand();
    const { args, unavailable } = this.buildEslintArgs(options, cwd, targetFiles);
    if (unavailable) return this.buildUnavailable(start, unavailable);

    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const rawOutput = JSON.parse(stdout);
    const issues = this.mapOutput(rawOutput, category);

    return this.buildAvailable(start, rawOutput, issues);
  }

  /** 组装 ESLint 命令行参数（含注入 flat config 的可用性探测） */
  private buildEslintArgs(options: ToolScanOptions, cwd: string, targetFiles: string[]): { args: string[]; unavailable?: string } {
    const defaultExts = ['--ext', '.ts,.tsx,.js,.jsx'];
    // ESLint v9 base-path 校验：绝对 target 在 config 文件目录之外会被静默忽略，故转相对路径
    const relativeTargets = targetFiles.map((target) => path.relative(cwd, target) || '.');
    const args: string[] = ['--format', 'json', ...defaultExts, ...relativeTargets];

    // 注入的 flat config 为规则声明（如 node_modules/@zh/kernel/dist/assets/...），
    // 仅在被扫描项目内部安装了对应依赖时才存在。对于未安装该依赖的外部项目，
    // 直接传入 --config 会让 ESLint 因 ENOENT 崩溃并使整次巡检失败；此处探测该
    // config 文件是否真实存在（按规则声明的相对路径相对 cwd 解析），缺失时退化为
    // unavailable（跳过该规则），而非硬错误。
    const injectedConfig = options.config?.config;
    if (injectedConfig) {
      const configPath = path.resolve(cwd, injectedConfig);
      if (!fs.existsSync(configPath)) {
        return { args, unavailable: `ESLint 性能配置不存在，跳过该规则: ${configPath}` };
      }
      // ESLint v9 中 --no-eslintrc 已移除；--config 指定 flat config 即不再查找其他配置
      args.unshift('--config', configPath);
    }

    return { args };
  }

  /** 处理 ESLint 执行错误：未安装 / 部分输出 / 失败 */
  private handleEslintError(error: unknown, start: number, category: IssueCategory): ToolResult {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return this.buildUnavailable(start, 'ESLint 未安装或未在 PATH 中找到');
    }

    let rawOutput: unknown = null;
    if (err.stdout) {
      try { rawOutput = JSON.parse(err.stdout); } catch { /* ignore */ }
    }
    if (rawOutput) {
      return this.buildAvailable(start, rawOutput, this.mapOutput(rawOutput, category));
    }

    return this.buildError(start, err.stderr || err.message || 'ESLint 执行失败');
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
      suggestion: msg.fix ? '可自动修复' : undefined,
      autoFixable: !!msg.fix,
      source: 'inspect',
      fingerprint: `${msg.ruleId}:${file.filePath || ''}:${msg.line || 0}`,
    };
  }
}
