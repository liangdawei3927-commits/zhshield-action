import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue, CodeFlow, CodeFlowThreadFlow, CodeFlowLocation } from '@zh/shared';
import type { ExecError, SemgrepOutput, SemgrepResult } from './tool-output-types';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'semgrep',
  name: 'Semgrep',
  category: 'security',
  priority: 'P0',
  installMode: 'builtin',
  description: '自定义安全 SOP 规则扫描',
  cliCommand: 'semgrep',
  homepage: 'https://semgrep.dev',
  license: 'LGPL-2.1',
};

export class SemgrepAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('semgrep', ['--version'], { timeout: 10000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const rulesDir = this.resolveRulesDir(options.projectPath);

    if (!rulesDir || !fs.existsSync(rulesDir)) {
      return this.buildSkippedResult(start);
    }

    try {
      const output = await this.runSemgrep(rulesDir, options);
      const issues = this.mapOutput(output);
      return this.buildSuccessResult(start, issues, output?.results?.length || 0);
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError);
    }
  }

  private buildSkippedResult(start: number): ToolResult {
    return {
      tool: 'semgrep',
      status: 'skipped',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: 'Semgrep 规则目录不存在，请先同步云脑规则',
    };
  }

  private async runSemgrep(rulesDir: string, options: ToolScanOptions): Promise<SemgrepOutput> {
    const isQuick = options.config?.severity?.includes('ERROR');
    const configArg = isQuick
      ? path.join(rulesDir, 'high-severity')
      : rulesDir;

    const args = ['scan', '--config', configArg, '--json'];
    if (options.targetFiles && options.targetFiles.length > 0) {
      args.push(...options.targetFiles);
    } else {
      args.push(options.projectPath);
    }

    const { stdout } = await execFileAsync('semgrep', args, {
      cwd: options.projectPath,
      timeout: options.timeout || 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout) as SemgrepOutput;
  }

  private buildSuccessResult(start: number, issues: Issue[], fileCount: number): ToolResult {
    return {
      tool: 'semgrep',
      status: 'available',
      issues,
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount },
    };
  }

  private buildErrorResult(start: number, err: ExecError): ToolResult {
    if (err.code === 'ENOENT') {
      return {
        tool: 'semgrep',
        status: 'unavailable',
        issues: [],
        metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
        error: 'Semgrep 未安装或未在 PATH 中找到',
      };
    }
    const partialIssues = this.parsePartialOutput(err.stdout);
    if (partialIssues) {
      return {
        tool: 'semgrep',
        status: 'available',
        issues: partialIssues,
        metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: partialIssues.length },
      };
    }
    return {
      tool: 'semgrep',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || 'Semgrep 执行失败',
    };
  }

  private parsePartialOutput(stdout: string | undefined): Issue[] | null {
    if (!stdout) return null;
    try {
      const output = JSON.parse(stdout);
      if (Array.isArray(output?.results)) {
        return this.mapOutput(output);
      }
    } catch {
      // 部分输出可能不是合法 JSON
    }
    return null;
  }

  private resolveRulesDir(projectPath: string): string | null {
    const candidates = [
      path.join(projectPath, '.zhshield', 'semgrep-rules'),
      path.join(projectPath, '.semgrep', 'rules'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) return dir;
    }
    return null;
  }

  private mapOutput(output: SemgrepOutput): Issue[] {
    if (!output?.results || !Array.isArray(output.results)) return [];
    return output.results.map((r) => ({
      id: randomUUID(),
      ruleId: `semgrep.${r.check_id || 'unknown'}`,
      severity: r.extra?.severity === 'ERROR' ? 'error'
        : r.extra?.severity === 'WARNING' ? 'warning' : 'info',
      category: 'security',
      message: r.extra?.message || r.extra?.metadata?.description || `Semgrep: ${r.check_id}`,
      file: r.path || '',
      line: r.start?.line || 0,
      column: r.start?.col || 0,
      suggestion: r.extra?.fix || undefined,
      autoFixable: !!r.extra?.fix,
      source: 'security',
      fingerprint: `semgrep:${r.check_id || ''}:${r.path || ''}:${r.start?.line || 0}`,
      codeFlows: this.mapCodeFlows(r.dataflow_trace),
    }));
  }

  private mapCodeFlows(trace: SemgrepResult['dataflow_trace']): CodeFlow[] | undefined {
    if (!trace?.code_flows?.length) return undefined;
    const flows: CodeFlow[] = [];
    for (const cf of trace.code_flows) {
      if (!cf.thread_flows?.length) continue;
      const threadFlows: CodeFlowThreadFlow[] = [];
      for (const tf of cf.thread_flows) {
        if (!tf.locations?.length) continue;
        const locations: CodeFlowLocation[] = [];
        for (const loc of tf.locations) {
          if (!loc.location) continue;
          locations.push({
            location: {
              file: loc.location.path || '',
              line: loc.location.start?.line,
              column: loc.location.start?.col,
            },
            message: loc.message,
          });
        }
        if (locations.length > 0) {
          threadFlows.push({ locations });
        }
      }
      if (threadFlows.length > 0) {
        flows.push({ threadFlows });
      }
    }
    return flows.length > 0 ? flows : undefined;
  }
}
