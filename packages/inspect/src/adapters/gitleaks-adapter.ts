import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue, AccessScope } from '@zh/shared';
import { resolveToolCommand } from './tool-bin';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'gitleaks',
  name: 'Gitleaks',
  category: 'inspect',
  priority: 'P0',
  installMode: 'builtin',
  description: '硬编码密钥扫描',
  cliCommand: 'gitleaks',
  homepage: 'https://github.com/gitleaks/gitleaks',
  license: 'MIT',
};

/** Gitleaks JSON 输出中的单条 finding */
interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  StartColumn?: number;
}

export class GitleaksAdapter implements ToolAdapter {
  meta = META;
  private commandPromise?: Promise<string>;
  private readonly projectRoot?: string;

  /** F5：gitleaks 读取仓库文本文件找硬编码密钥；依赖目录排除 */
  readonly accessScope: AccessScope = {
    readPaths: ['**/*.{env,ts,js,json,yaml,yml}'],
    excludePaths: ['**/node_modules/**'],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
  }

  private resolveCommand(): Promise<string> {
    if (!this.commandPromise) {
      this.commandPromise = resolveToolCommand('gitleaks', this.projectRoot);
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
    const isStaged = !!(options.targetFiles && options.targetFiles.length > 0);

    try {
      return await this.runGitleaks(options, start, isStaged);
    } catch (error: unknown) {
      return this.handleGitleaksError(error, start);
    }
  }

  /** 执行 gitleaks 并映射输出为可用结果 */
  private async runGitleaks(options: ToolScanOptions, start: number, isStaged: boolean): Promise<ToolResult> {
    const command = await this.resolveCommand();
    const { stdout } = await execFileAsync(command, this.buildArgs(options, isStaged), {
      cwd: options.projectPath,
      timeout: options.timeout || 30000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout);
    const findings = Array.isArray(parsed) ? parsed : (parsed?.findings || []);
    return this.buildAvailable(findings, start);
  }

  /** 处理 gitleaks 执行错误：未安装 / 部分输出 / 失败 */
  private handleGitleaksError(error: unknown, start: number): ToolResult {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return this.buildUnavailable(start, 'Gitleaks 未安装或未在 PATH 中找到');
    }

    // gitleaks 检测到密钥时退出码非 0，但 stdout 仍含有效 JSON findings
    const partialFindings = this.parsePartialFindings(err.stdout ?? '');
    if (partialFindings) {
      return this.buildAvailable(partialFindings, start);
    }
    return this.buildError(start, err.stderr || err.message || 'Gitleaks 执行失败');
  }

  private parsePartialFindings(stdout: string): Record<string, unknown>[] | null {
    if (!stdout) return null;
    try {
      const parsed = JSON.parse(stdout);
      const findings = Array.isArray(parsed) ? parsed : (parsed?.findings || []);
      return findings.length > 0 ? findings : null;
    } catch {
      return null;
    }
  }

  private buildArgs(options: ToolScanOptions, isStaged: boolean): string[] {
    // gitleaks v8.28+ 移除了 detect 的 --format/--staged：JSON 输出统一走全局
    // --report-format/--report-path（"-"=stdout）；暂存扫描走 `git --staged` 子命令（仓库路径为位置参数，不支持 --source）。
    const args = isStaged ? ['git', '--staged'] : ['detect', '--source', options.projectPath];
    args.push('--report-format', 'json', '--report-path', '-');
    if (isStaged) {
      args.push(options.projectPath);
    }
    if (options.config?.config) {
      args.push('--config', options.config.config);
    }
    return args;
  }

  private buildAvailable(findings: Record<string, unknown>[], start: number): ToolResult {
    return {
      tool: 'gitleaks',
      status: 'available',
      issues: this.mapOutput(findings),
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: findings.length,
      },
    };
  }

  private buildUnavailable(start: number, error: string): ToolResult {
    return {
      tool: 'gitleaks',
      status: 'unavailable',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private buildError(start: number, error: string): ToolResult {
    return {
      tool: 'gitleaks',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private mapOutput(findings: Record<string, unknown>[]): Issue[] {
    if (!Array.isArray(findings)) return [];
    return findings.map((f) => {
      const finding = f as GitleaksFinding;
      return {
        id: randomUUID(),
        ruleId: finding.RuleID || 'gitleaks-unknown',
        severity: 'error',
        category: 'security',
        message: finding.Description || `检测到硬编码密钥: ${finding.RuleID || '未知'}`,
        file: finding.File || '',
        line: finding.StartLine || 0,
        column: finding.StartColumn || 0,
        suggestion: '移除硬编码密钥，使用环境变量或密钥管理服务',
        autoFixable: false,
        source: 'inspect',
        fingerprint: `gitleaks:${finding.RuleID || ''}:${finding.File || ''}:${finding.StartLine || 0}`,
      };
    });
  }
}
