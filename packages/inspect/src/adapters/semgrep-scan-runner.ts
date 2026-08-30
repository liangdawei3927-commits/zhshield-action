import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolScanOptions, ToolResult, Issue, IssueCategory } from '@zh/shared';
import { SemgrepResultMapper, type SemgrepOutput } from './semgrep-result-mapper';

const execFileAsync = promisify(execFile);

/** 本机 semgrep-core（OCaml 运行时）每次启动都会打印的无害告警，非扫描失败原因 */
const RUNTIME_NOISE_PATTERNS: readonly RegExp[] = [
  /Failed to register segfault signal handler/,
  /Failed to register unwind handler/,
];

/**
 * SemgrepScanRunner — 执行 semgrep 扫描并映射输出为可用结果，统一处理执行错误
 *
 * 职责：调用 semgrep CLI、解析 JSON 输出、把结果/错误归一化为 ToolResult。
 * 结果映射委托给 SemgrepResultMapper，本类只负责执行编排与错误兜底。
 */
export class SemgrepScanRunner {
  private readonly mapper = new SemgrepResultMapper();

  /** 执行 semgrep 扫描并映射输出为可用结果 */
  async run(command: string, options: ToolScanOptions, args: string[], category: IssueCategory, start: number): Promise<ToolResult> {
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd: options.projectPath,
        timeout: options.timeout || 120000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const output = JSON.parse(stdout);
      return this.buildAvailable(output, this.mapper.mapOutput(output, category), start);
    } catch (error: unknown) {
      return this.handleError(error, start, category);
    }
  }

  /** 处理 semgrep 执行错误：未安装 / 超时 / 输出错误 */
  private handleError(error: unknown, start: number, category: IssueCategory): ToolResult {
    const err = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return this.buildUnavailable(start, 'Semgrep 未安装或未在 PATH 中找到');
    }
    if (err.code === 'ETIMEDOUT') {
      return this.buildError(start, 'Semgrep 扫描超时');
    }
    return this.handleOutputError(err, start, category);
  }

  /** 从 semgrep 输出中提取真实错误或部分结果 */
  private handleOutputError(
    err: { code?: number | string; stdout?: string; stderr?: string; message?: string },
    start: number,
    category: IssueCategory,
  ): ToolResult {
    // 优先报告 JSON errors 中的真实错误，而非 OCaml 运行时噪音
    const jsonError = this.extractJsonError(err.stdout);
    if (jsonError) {
      return this.buildError(start, jsonError);
    }

    // semgrep 存在 findings 时退出码为 1；stdout 仍为有效 JSON
    const partial = this.parsePartialOutput(err.stdout ?? '', category, err.stderr);
    if (partial) {
      return this.buildAvailable(partial.output, partial.issues, start);
    }

    // 兜底：剔除 OCaml 运行时噪音后使用 stderr / message
    return this.buildError(start, this.stripRuntimeNoise(err.stderr) || err.message || 'Semgrep 执行失败');
  }

  private extractJsonError(stdout?: string): string | null {
    if (!stdout) return null;
    try {
      const output = JSON.parse(stdout) as SemgrepOutput;
      const first = output.errors?.find((e) => typeof e.message === 'string' && e.message.length > 0);
      return first?.message ?? null;
    } catch {
      return null;
    }
  }

  private stripRuntimeNoise(stderr?: string): string {
    if (!stderr) return '';
    return stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !RUNTIME_NOISE_PATTERNS.some((pattern) => pattern.test(line)))
      .join('\n');
  }

  private parsePartialOutput(
    stdout: string,
    category: IssueCategory,
    stderr?: string,
  ): { output: SemgrepOutput; issues: Issue[] } | null {
    if (!stdout) return null;
    try {
      const output = JSON.parse(stdout);
      const issues = this.mapper.mapOutput(output, category);
      if (issues.length > 0 || !stderr) {
        return { output, issues };
      }
    } catch {
      return null;
    }
    return null;
  }

  buildAvailable(output: SemgrepOutput, issues: Issue[], start: number): ToolResult {
    return {
      tool: 'semgrep',
      status: 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: Array.isArray(output.results) ? output.results.length : 0,
      },
    };
  }

  buildUnavailable(start: number, error: string): ToolResult {
    return {
      tool: 'semgrep',
      status: 'unavailable',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  buildError(start: number, error: string): ToolResult {
    return {
      tool: 'semgrep',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }
}
