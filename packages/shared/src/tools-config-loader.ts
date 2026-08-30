import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolConfig, ToolsConfig, GuardConfig } from './types';
import { parseSimpleYaml } from './simple-yaml';

interface RawToolsYaml {
  tools?: Record<string, Record<string, unknown>>;
}

interface RawGuardYaml {
  guard?: {
    'pre-commit'?: { enabled?: boolean; checks?: string[]; timeout?: number };
    'pre-push'?: { enabled?: boolean; checks?: string[]; timeout?: number };
    ci?: { enabled?: boolean; checks?: string[]; timeout?: number };
  };
}

export class ToolsConfigLoader {
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  private findConfigFile(...names: string[]): string | null {
    for (const name of names) {
      const p = path.join(this.projectPath, '.zhshield', name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  loadToolsConfig(): ToolsConfig | null {
    const filePath = this.findConfigFile('tools.yml', 'tools.yaml');
    if (!filePath) return null;
    return this.parseToolsFile(filePath);
  }

  /** 读取并解析 tools 配置文件（异常时返回 null） */
  private parseToolsFile(filePath: string): ToolsConfig | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseSimpleYaml(content) as RawToolsYaml;

      if (!parsed.tools) return null;

      return { tools: this.buildToolsConfig(parsed.tools) };
    } catch {
      return null;
    }
  }

  /** 从解析后的 tools 段构建全量工具配置 */
  private buildToolsConfig(tools: RawToolsYaml['tools']): ToolsConfig['tools'] {
    return {
      eslint: this.parseToolConfig(tools!.eslint || {}),
      semgrep: this.parseToolConfig(tools!.semgrep || {}),
      trivy: this.parseToolConfig(tools!.trivy || {}),
      gitleaks: this.parseToolConfig(tools!.gitleaks || {}),
      grype: this.parseToolConfig(tools!.grype || {}),
      ort: this.parseToolConfig(tools!.ort || {}),
      depcheck: this.parseToolConfig(tools!.depcheck || {}),
      'dependency-cruiser': this.parseToolConfig(tools!['dependency-cruiser'] || {}),
      'ts-prune': this.parseToolConfig(tools!['ts-prune'] || {}),
    };
  }

  loadGuardConfig(): GuardConfig | null {
    const filePath = this.findConfigFile('guard.yml', 'guard.yaml');
    if (!filePath) return null;
    return this.parseGuardFile(filePath);
  }

  /** 读取并解析 guard 配置文件（异常时返回 null） */
  private parseGuardFile(filePath: string): GuardConfig | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseSimpleYaml(content) as RawGuardYaml;

      if (!parsed.guard) return null;

      return this.buildGuardConfig(parsed.guard);
    } catch {
      return null;
    }
  }

  /** 从解析后的 guard 段构建门禁配置（带默认值） */
  private buildGuardConfig(g: NonNullable<RawGuardYaml['guard']>): GuardConfig {
    return {
      guard: {
        'pre-commit': {
          enabled: g['pre-commit']?.enabled ?? true,
          checks: g['pre-commit']?.checks || ['eslint', 'gitleaks'],
          timeout: g['pre-commit']?.timeout || 5000,
        },
        'pre-push': {
          enabled: g['pre-push']?.enabled ?? true,
          checks: g['pre-push']?.checks || ['eslint', 'semgrep-high-severity', 'trivy'],
          timeout: g['pre-push']?.timeout || 30000,
        },
        ci: {
          enabled: g.ci?.enabled ?? true,
          checks: g.ci?.checks || ['all-pre-push', 'dependency-cruiser', 'ort'],
          timeout: g.ci?.timeout || 120000,
        },
      },
    };
  }

  private parseToolConfig(raw: Record<string, unknown>): ToolConfig {
    return {
      enabled: (raw.enabled as boolean) ?? true,
      config: raw.config as string | undefined,
      ignore: raw.ignore as string[] | undefined,
      severity: raw.severity as string[] | undefined,
      scanners: raw.scanners as string[] | undefined,
      rules: raw.rules as string[] | undefined,
      packageManagers: raw.packageManagers as string[] | undefined,
      timeout: raw.timeout as number | undefined,
    };
  }
}
