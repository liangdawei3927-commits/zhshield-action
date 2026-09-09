import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';
import type {
  ExecError,
  TrivyOutput,
  TrivyResult,
  TrivyVulnerability,
  TrivySecret,
} from './tool-output-types';

const execFileAsync = promisify(execFile);

/**
 * trivy 启动扫描时若本地无漏洞库（或版本过期），会尝试联网更新 DB；
 * 离线/受限环境下载失败即抛错，stderr 出现以下签名。此时报错应给出可操作的
 * 解决指引（预置 DB 或设置镜像/离线环境变量），而非原始下载日志噪音。
 * 注意：trivy 子进程继承 process.env，运营侧可直接用 TRIVY_SKIP_DB_UPDATE=1 /
 * TRIVY_OFFLINE_SCAN=1 / TRIVY_DB_REPOSITORY=<镜像> 控制，无需改代码；
 * 但首次运行（无任何本地缓存）时 --skip-db-update 会被 trivy 拒绝
 * （"first run cannot skip downloading DB"），必须先联网预置一次 DB。
 */
const DB_UNAVAILABLE_MARKERS: readonly RegExp[] = [
  /Need to update DB/,
  /Downloading vulnerability DB/,
  /Downloading artifact.*trivy-db/,
  /first run cannot skip downloading DB/,
  /--skip-db-update cannot be specified on the first run/,
];

const META: ToolMeta = {
  id: 'trivy',
  name: 'Trivy',
  category: 'security',
  priority: 'P0',
  installMode: 'on-demand',
  description: '依赖/文件/构建产物/镜像漏洞扫描',
  cliCommand: 'trivy',
  homepage: 'https://trivy.dev',
  license: 'Apache-2.0',
};

type TrivyScanType = 'dependency' | 'filesystem' | 'config' | 'image';

/** 扫描类型 → trivy CLI 参数构建策略表（替代 buildArgs 中的 switch 分派） */
const ARG_BUILDERS: Partial<
  Record<TrivyScanType, (projectPath: string, options?: ToolScanOptions) => string[]>
> = {
  dependency: (projectPath) => [
    'fs',
    '--format',
    'json',
    '--severity',
    'HIGH,CRITICAL',
    path.join(projectPath, 'package.json'),
  ],
  filesystem: (projectPath) => ['fs', '--format', 'json', '--scanners', 'vuln,secret', projectPath],
  config: (projectPath) => ['config', '--format', 'json', projectPath],
  image: (projectPath, options) => {
    const imageName = options?.config?.rules?.[0] || projectPath;
    return ['image', '--format', 'json', '--severity', 'HIGH,CRITICAL', imageName];
  },
};

export class TrivyAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('trivy', ['--version'], { timeout: 10000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const scanTypes: TrivyScanType[] = (options.config?.scanners as TrivyScanType[]) || [
      'dependency',
    ];

    try {
      const allIssues: Issue[] = [];
      for (const scanType of scanTypes) {
        const issues = await this.runTrivyScan(scanType, options);
        if (issues) allIssues.push(...issues);
      }

      return {
        tool: 'trivy',
        status: 'available',
        issues: allIssues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: allIssues.length,
        },
      };
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError);
    }
  }

  private async runTrivyScan(
    scanType: TrivyScanType,
    options: ToolScanOptions,
  ): Promise<Issue[] | null> {
    const args = this.buildArgs(scanType, options.projectPath, options);
    if (!args) return null;
    const { stdout } = await execFileAsync('trivy', args, {
      cwd: options.projectPath,
      timeout: options.timeout || 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const output = JSON.parse(stdout);
    return this.mapOutput(output);
  }

  private buildErrorResult(start: number, err: ExecError): ToolResult {
    if (err.code === 'ENOENT') {
      return {
        tool: 'trivy',
        status: 'unavailable',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error: 'Trivy 未安装，请运行 trivy 安装命令',
      };
    }
    // 漏洞库下载失败（离线/受限网络）给可操作指引，而非原始下载日志噪音
    if (this.isDbUnavailableError(err)) {
      return {
        tool: 'trivy',
        status: 'error',
        issues: [],
        metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
        error:
          'Trivy 漏洞库不可用：无法下载/更新 DB（离线或网络受限）。' +
          '请先联网执行一次 `trivy image --download-db-only` 预置缓存；' +
          '或设置环境变量 TRIVY_SKIP_DB_UPDATE=1（使用已有缓存）/ TRIVY_DB_REPOSITORY=<镜像地址>（指向可达镜像）。',
      };
    }
    return {
      tool: 'trivy',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || 'Trivy 执行失败',
    };
  }

  /** 命中 trivy 漏洞库下载失败签名（Need to update DB / Downloading vulnerability DB / Downloading artifact） */
  private isDbUnavailableError(err: ExecError): boolean {
    const stderr = err.stderr;
    if (!stderr) return false;
    return DB_UNAVAILABLE_MARKERS.some((marker) => marker.test(stderr));
  }

  private buildArgs(
    scanType: TrivyScanType,
    projectPath: string,
    options?: ToolScanOptions,
  ): string[] | null {
    const build = ARG_BUILDERS[scanType];
    return build ? build(projectPath, options) : null;
  }

  private mapOutput(output: TrivyOutput): Issue[] {
    if (!output?.Results || !Array.isArray(output.Results)) return [];
    const issues: Issue[] = [];

    for (const result of output.Results) {
      issues.push(...this.mapResultVulnerabilities(result));
      issues.push(...this.mapResultSecrets(result));
    }

    return issues;
  }

  private mapResultVulnerabilities(result: TrivyResult): Issue[] {
    if (!Array.isArray(result.Vulnerabilities)) return [];
    return result.Vulnerabilities.map((vuln) => this.mapVulnerability(vuln, result.Target || ''));
  }

  private mapVulnerability(vuln: TrivyVulnerability, target: string): Issue {
    const sev = (vuln.Severity || '').toUpperCase();
    return {
      id: randomUUID(),
      ruleId: vuln.VulnerabilityID || 'trivy-unknown',
      severity:
        sev === 'CRITICAL' || sev === 'HIGH' ? 'error' : sev === 'MEDIUM' ? 'warning' : 'info',
      category: 'security',
      message: `${vuln.PkgName || '?'}@${vuln.InstalledVersion || '?'}: ${vuln.Title || vuln.VulnerabilityID || ''}`,
      file: target,
      line: 0,
      column: 0,
      suggestion: vuln.FixedVersion ? `升级到 ${vuln.FixedVersion}` : undefined,
      autoFixable: !!vuln.FixedVersion,
      source: 'security',
      fingerprint: `trivy:${vuln.VulnerabilityID || ''}:${target}:${vuln.PkgName || ''}`,
    };
  }

  private mapResultSecrets(result: TrivyResult): Issue[] {
    if (!Array.isArray(result.Secrets)) return [];
    return result.Secrets.map((secret) => this.mapSecret(secret, result.Target || ''));
  }

  private mapSecret(secret: TrivySecret, target: string): Issue {
    return {
      id: randomUUID(),
      ruleId: `trivy-secret-${secret.RuleID || 'unknown'}`,
      severity: 'error',
      category: 'security',
      message: secret.Title || `Secret detected: ${secret.RuleID}`,
      file: secret.File || target,
      line: secret.StartLine || 0,
      column: 0,
      suggestion: '移除硬编码的密钥，使用环境变量或密钥管理服务',
      autoFixable: false,
      source: 'security',
      fingerprint: `trivy-secret:${secret.RuleID || ''}:${secret.File || ''}:${secret.StartLine || 0}`,
    };
  }
}
