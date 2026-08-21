import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TrivyFinding {
  id: string;
  target: string;
  vulnerability?: {
    vulnerabilityId: string;
    severity: string;
    title: string;
    description: string;
    fixedVersion?: string;
  };
  misconfiguration?: {
    id: string;
    severity: string;
    title: string;
    description: string;
  };
}

export interface TrivyResult {
  SchemaVersion?: number;
  ArtifactName?: string;
  Results?: Array<{
    Target: string;
    Class?: string;
    Type?: string;
    Vulnerabilities?: Array<{
      VulnerabilityID: string;
      PkgName?: string;
      InstalledVersion?: string;
      FixedVersion?: string;
      Severity: string;
      Title?: string;
      Description?: string;
    }>;
    Misconfigurations?: Array<{
      ID: string;
      Severity: string;
      Title?: string;
      Description?: string;
    }>;
  }>;
}

export class TrivyAdapter {
  private trivyPath: string;

  constructor(trivyPath = 'trivy') {
    this.trivyPath = trivyPath;
  }

  /**
   * 检查 trivy 是否可用
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.trivyPath, ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 运行漏洞扫描
   */
  async scanVulnerabilities(
    projectPath: string,
    options?: { severity?: string; format?: string },
  ): Promise<TrivyFinding[]> {
    const args = [
      'fs',
      '--format', 'json',
      '--vuln-type', 'os,library',
    ];

    if (options?.severity) {
      args.push('--severity', options.severity);
    }

    args.push(projectPath);

    try {
      const { stdout } = await execFileAsync(this.trivyPath, args, {
        timeout: 120_000, // 2 minutes
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      const result = JSON.parse(stdout) as TrivyResult;
      return this.parseVulnerabilities(result);
    } catch (err) {
      console.warn('[TrivyAdapter] Vulnerability scan failed:', err);
      return [];
    }
  }

  /**
   * 运行配置扫描
   */
  async scanMisconfigurations(projectPath: string): Promise<TrivyFinding[]> {
    const args = [
      'fs',
      '--format', 'json',
      '--scanners', 'config',
      projectPath,
    ];

    try {
      const { stdout } = await execFileAsync(this.trivyPath, args, {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const result = JSON.parse(stdout) as TrivyResult;
      return this.parseMisconfigurations(result);
    } catch (err) {
      console.warn('[TrivyAdapter] Misconfiguration scan failed:', err);
      return [];
    }
  }

  /**
   * 运行完整扫描
   */
  async scan(
    projectPath: string,
    options?: { severity?: string },
  ): Promise<{
    vulnerabilities: TrivyFinding[];
    misconfigurations: TrivyFinding[];
    summary: { total: number; critical: number; high: number; medium: number; low: number };
  }> {
    const [vulnerabilities, misconfigurations] = await Promise.all([
      this.scanVulnerabilities(projectPath, options),
      this.scanMisconfigurations(projectPath),
    ]);

    const all = [...vulnerabilities, ...misconfigurations];
    const summary = {
      total: all.length,
      critical: all.filter(f => this.getSeverity(f) === 'CRITICAL').length,
      high: all.filter(f => this.getSeverity(f) === 'HIGH').length,
      medium: all.filter(f => this.getSeverity(f) === 'MEDIUM').length,
      low: all.filter(f => this.getSeverity(f) === 'LOW').length,
    };

    return { vulnerabilities, misconfigurations, summary };
  }

  // --- Private helpers ---

  private parseVulnerabilities(result: TrivyResult): TrivyFinding[] {
    const findings: TrivyFinding[] = [];
    for (const scanResult of result.Results ?? []) {
      for (const v of scanResult.Vulnerabilities ?? []) {
        findings.push({
          id: v.VulnerabilityID ?? '',
          target: scanResult.Target ?? '',
          vulnerability: {
            vulnerabilityId: v.VulnerabilityID ?? '',
            severity: v.Severity ?? 'UNKNOWN',
            title: v.Title ?? '',
            description: v.Description ?? '',
            fixedVersion: v.FixedVersion,
          },
        });
      }
    }
    return findings;
  }

  private parseMisconfigurations(result: TrivyResult): TrivyFinding[] {
    const findings: TrivyFinding[] = [];
    for (const scanResult of result.Results ?? []) {
      for (const m of scanResult.Misconfigurations ?? []) {
        findings.push({
          id: m.ID ?? '',
          target: scanResult.Target ?? '',
          misconfiguration: {
            id: m.ID ?? '',
            severity: m.Severity ?? 'UNKNOWN',
            title: m.Title ?? '',
            description: m.Description ?? '',
          },
        });
      }
    }
    return findings;
  }

  private getSeverity(finding: TrivyFinding): string {
    return (finding.vulnerability?.severity ?? finding.misconfiguration?.severity ?? 'UNKNOWN').toUpperCase();
  }
}
