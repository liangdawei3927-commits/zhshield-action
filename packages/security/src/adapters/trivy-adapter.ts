import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';
import type { ExecError, TrivyOutput, TrivyResult, TrivyVulnerability, TrivySecret } from './tool-output-types';

const execFileAsync = promisify(execFile);

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
const ARG_BUILDERS: Partial<Record<TrivyScanType, (projectPath: string, options?: ToolScanOptions) => string[]>> = {
  dependency: (projectPath) => [
    'fs', '--format', 'json',
    '--severity', 'HIGH,CRITICAL',
    path.join(projectPath, 'package.json'),
  ],
  filesystem: (projectPath) => [
    'fs', '--format', 'json',
    '--scanners', 'vuln,secret',
    projectPath,
  ],
  config: (projectPath) => [
    'config', '--format', 'json',
    projectPath,
  ],
  image: (projectPath, options) => {
    const imageName = options?.config?.rules?.[0] || projectPath;
    return [
      'image', '--format', 'json',
      '--severity', 'HIGH,CRITICAL',
      imageName,
    ];
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
    const scanTypes: TrivyScanType[] = (options.config?.scanners as TrivyScanType[]) || ['dependency'];

    try {
      const allIssues: Issue[] = [];

      for (const scanType of scanTypes) {
        const args = this.buildArgs(scanType, options.projectPath, options);
        if (!args) continue;

        const { stdout } = await execFileAsync('trivy', args, {
          cwd: options.projectPath,
          timeout: options.timeout || 120000,
          maxBuffer: 20 * 1024 * 1024,
        });

        const output = JSON.parse(stdout);
        const issues = this.mapOutput(output);
        allIssues.push(...issues);
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
      const err = error as ExecError;
      if (err.code === 'ENOENT') {
        return {
          tool: 'trivy',
          status: 'unavailable',
          issues: [],
          metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
          error: 'Trivy 未安装，请运行 trivy 安装命令',
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
  }

  private buildArgs(scanType: TrivyScanType, projectPath: string, options?: ToolScanOptions): string[] | null {
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
      severity: sev === 'CRITICAL' || sev === 'HIGH' ? 'error'
        : sev === 'MEDIUM' ? 'warning' : 'info',
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
