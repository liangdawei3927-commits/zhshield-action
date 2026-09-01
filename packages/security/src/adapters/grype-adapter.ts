import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';
import type { ExecError, GrypeOutput } from './tool-output-types';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'grype',
  name: 'Grype',
  category: 'security',
  priority: 'P1',
  installMode: 'on-demand',
  description: '依赖漏洞交叉复核',
  cliCommand: 'grype',
  homepage: 'https://github.com/anchore/grype',
  license: 'Apache-2.0',
};

export class GrypeAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('grype', ['version'], { timeout: 10000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();

    try {
      const source = this.resolveScanSource(options);
      const output = await this.runGrype(source, options);
      const issues = this.mapOutput(output);

      return {
        tool: 'grype',
        status: 'available',
        issues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: output?.matches?.length || 0,
        },
      };
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError);
    }
  }

  private resolveScanSource(options: ToolScanOptions): string {
    // 支持 docker 镜像扫描：config.rules[0] 作为镜像名，否则扫描目录
    return options.config?.rules?.[0] ? options.config.rules[0] : `dir:${options.projectPath}`;
  }

  private async runGrype(source: string, options: ToolScanOptions): Promise<GrypeOutput> {
    const { stdout } = await execFileAsync('grype', [source, '-o', 'json'], {
      cwd: options.projectPath,
      timeout: options.timeout || 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  private buildErrorResult(start: number, err: ExecError): ToolResult {
    if (err.code === 'ENOENT') {
      return {
        tool: 'grype',
        status: 'unavailable',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error: 'Grype 未安装',
      };
    }
    const partialIssues = this.parsePartialOutput(err.stdout);
    if (partialIssues) {
      return {
        tool: 'grype',
        status: 'available',
        issues: partialIssues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: partialIssues.length,
        },
      };
    }
    return {
      tool: 'grype',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || 'Grype 执行失败',
    };
  }

  private parsePartialOutput(stdout: string | undefined): Issue[] | null {
    if (!stdout) return null;
    try {
      const output = JSON.parse(stdout);
      if (Array.isArray(output?.matches)) {
        return this.mapOutput(output);
      }
    } catch {
      // 部分输出可能不是合法 JSON
    }
    return null;
  }

  private mapOutput(output: GrypeOutput): Issue[] {
    if (!output?.matches || !Array.isArray(output.matches)) return [];
    return output.matches.map((m) => {
      const sev = (m.vulnerability?.severity || '').toLowerCase();
      return {
        id: randomUUID(),
        ruleId: m.vulnerability?.id || 'grype-unknown',
        severity:
          sev === 'critical' || sev === 'high' ? 'error' : sev === 'medium' ? 'warning' : 'info',
        category: 'security',
        message: `${m.artifact?.name || '?'}@${m.artifact?.version || '?'}: ${m.vulnerability?.description || m.vulnerability?.id || ''}`,
        file: '',
        line: 0,
        column: 0,
        suggestion: m.vulnerability?.fixedInVersion
          ? `升级到 ${m.vulnerability.fixedInVersion}`
          : undefined,
        autoFixable: !!m.vulnerability?.fixedInVersion,
        source: 'security',
        fingerprint: `grype:${m.vulnerability?.id || ''}:${m.artifact?.name || ''}`,
      };
    });
  }
}
