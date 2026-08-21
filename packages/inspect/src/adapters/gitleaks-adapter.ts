import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';

const execFileAsync = promisify(execFile);

const META: Omit<ToolMeta, 'description'> = {
  id: 'gitleaks',
  name: 'Gitleaks',
  category: 'inspect',
  priority: 'P0',
  installMode: 'builtin',
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
  meta: ToolMeta;
  private readonly locale: LanguageCode;

  constructor(locale?: LanguageCode) {
    this.locale = locale ?? DEFAULT_LANGUAGE;
    this.meta = { ...META, description: translate('engine.inspect.tool.gitleaks.description', this.locale) };
  }

  private tr(key: string, params?: Record<string, unknown>): string {
    return translate(key, this.locale, params);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('gitleaks', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const isStaged = !!(options.targetFiles && options.targetFiles.length > 0);

    try {
      const stdout = await this.runGitleaks(options, isStaged);
      const findings = this.parseGitleaksOutput(stdout);
      return this.buildAvailable(findings, start);
    } catch (error: unknown) {
      return this.buildScanError(start, error);
    }
  }

  private async runGitleaks(options: ToolScanOptions, isStaged: boolean): Promise<string> {
    // gitleaks v8.19+ 移除了 --staged 标志：暂存区扫描改为 git diff --staged | gitleaks detect --pipe
    if (isStaged) {
      const { stdout: diff } = await execFileAsync(
        'git',
        ['diff', '--staged', '--', ...(options.targetFiles ?? [])],
        { cwd: options.projectPath, maxBuffer: 10 * 1024 * 1024 },
      );
      return this.runGitleaksPipe(diff, options);
    }
    const { stdout } = await execFileAsync('gitleaks', this.buildArgs(options), {
      cwd: options.projectPath,
      timeout: options.timeout || 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  /** gitleaks detect --pipe 需要从 stdin 读取 diff，execFile 无法注入 stdin，改用 spawn */
  private runGitleaksPipe(diff: string, options: ToolScanOptions): Promise<string> {
    const args = ['detect', '--pipe', '--report-format', 'json', '--report-path', '-'];
    if (options.config?.config) {
      args.push('--config', options.config.config);
    }
    return new Promise((resolve, reject) => {
      const child = spawn('gitleaks', args, { cwd: options.projectPath });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        // gitleaks 检测到密钥时退出码非 0，但 stdout 仍含有效 JSON findings
        if (code !== 0 && !stdout) reject(new Error(stderr || `gitleaks exited with code ${code}`));
        else resolve(stdout);
      });
      child.stdin.on('error', reject);
      child.stdin.end(diff);
    });
  }

  private parseGitleaksOutput(stdout: string): Record<string, unknown>[] {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : (parsed?.findings || []);
  }

  private buildScanError(start: number, error: unknown): ToolResult {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return this.buildUnavailable(start, this.tr('engine.inspect.tool.gitleaks.unavailable'));
    }

    // gitleaks 检测到密钥时退出码非 0，但 stdout 仍含有效 JSON findings
    const partialFindings = this.parsePartialFindings(err.stdout ?? '');
    if (partialFindings) {
      return this.buildAvailable(partialFindings, start);
    }
    return this.buildError(start, err.stderr || err.message || this.tr('engine.inspect.tool.gitleaks.runFailed'));
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

  private buildArgs(options: ToolScanOptions): string[] {
    // gitleaks v8.16+ 使用 --report-format/--report-path，旧的 --format 已被移除
    const args = [
      'detect',
      '--source',
      options.projectPath,
      '--report-format',
      'json',
      '--report-path',
      '-',
    ];
    if (options.config?.config) {
      args.push('--config', options.config.config);
    }
    return args;
  }

  private buildAvailable(findings: Record<string, unknown>[], start: number): ToolResult {
    return {
      tool: 'gitleaks',
      status: 'available',
      issues: this.mapOutput(findings, this.locale),
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

  private mapOutput(findings: Record<string, unknown>[], locale?: LanguageCode): Issue[] {
    if (!Array.isArray(findings)) return [];
    const lng = locale ?? DEFAULT_LANGUAGE;
    return findings.map((f) => {
      const finding = f as GitleaksFinding;
      return {
        id: randomUUID(),
        ruleId: finding.RuleID || 'gitleaks-unknown',
        severity: 'error',
        category: 'security',
        message: finding.Description || translate('engine.inspect.tool.gitleaks.hardcodedSecret', lng, { rule: finding.RuleID || translate('engine.inspect.unknown', lng) }),
        file: finding.File || '',
        line: finding.StartLine || 0,
        column: finding.StartColumn || 0,
        suggestion: translate('engine.inspect.tool.gitleaks.removeSecret', lng),
        autoFixable: false,
        source: 'inspect',
        fingerprint: `gitleaks:${finding.RuleID || ''}:${finding.File || ''}:${finding.StartLine || 0}`,
      };
    });
  }
}
