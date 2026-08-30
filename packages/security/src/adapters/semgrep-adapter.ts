import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue, CodeFlow, CodeFlowThreadFlow } from '@zh/shared';
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

    try {
      if (!rulesDir || !fs.existsSync(rulesDir)) {
        return {
          tool: 'semgrep',
          status: 'skipped',
          issues: [],
          metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
          error: 'Semgrep 规则目录不存在，请先同步云脑规则',
        };
      }
      const args = this.buildScanArgs(rulesDir, options);
      const output = await this.runSemgrep(args, options);
      const issues = this.mapOutput(output);

      return {
        tool: 'semgrep',
        status: 'available',
        issues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: output?.results?.length || 0,
        },
      };
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError);
    }
  }

  private buildScanArgs(rulesDir: string, options: ToolScanOptions): string[] {
    const isQuick = options.config?.severity?.includes('ERROR');
    const configArg = isQuick ? path.join(rulesDir, 'high-severity') : rulesDir;
    const args = ['scan', '--config', configArg, '--json'];
    if (options.targetFiles && options.targetFiles.length > 0) {
      args.push(...options.targetFiles);
    } else {
      args.push(options.projectPath);
    }
    return args;
  }

  private async runSemgrep(args: string[], options: ToolScanOptions): Promise<SemgrepOutput> {
    const { stdout } = await execFileAsync('semgrep', args, {
      cwd: options.projectPath,
      timeout: options.timeout || 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
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
      codeFlows: this.mapDataflowTrace(r),
    }));
  }

  /** dataflow_trace → SARIF 兼容 codeFlows（source→sink 污点链；缺 location 子对象的条目跳过）。顶层与 extra 嵌套两种落点都接受 */
  private mapDataflowTrace(result: SemgrepResult): CodeFlow[] | undefined {
    const trace = result.dataflow_trace ?? result.extra?.dataflow_trace;
    const codeFlows = trace?.code_flows;
    if (!codeFlows || codeFlows.length === 0) return undefined;
    const flows: CodeFlow[] = [];
    for (const codeFlow of codeFlows) {
      const threadFlows: CodeFlowThreadFlow[] = [];
      for (const threadFlow of codeFlow.thread_flows ?? []) {
        const locations = (threadFlow.locations ?? [])
          .filter((loc) => loc.location)
          .map((loc) => ({
            location: {
              file: loc.location?.path ?? '',
              line: loc.location?.start?.line ?? 0,
              column: loc.location?.start?.col ?? 0,
            },
            message: loc.message,
          }));
        threadFlows.push({ locations });
      }
      if (threadFlows.length > 0) flows.push({ threadFlows });
    }
    return flows.length > 0 ? flows : undefined;
  }
}
