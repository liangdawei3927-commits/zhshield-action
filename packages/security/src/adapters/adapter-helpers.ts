/**
 * 安全域各 CLI 工具适配器（grype / semgrep / trivy / ort / depcheck）共用的样板逻辑。
 *
 * 此前每个适配器的 `isAvailable()`、`ToolResult.metadata`、`buildErrorResult()` 的
 * 「ENOENT→unavailable / 部分输出→available / 否则→error」三段式都在逐字重复，
 * 仅工具名与提示语不同。收敛到此处，减少结构性重复、保证错误语义一致。
 */
import type { Issue, ToolResult } from '@zh/shared';
import { resolveToolCommandDetailed } from '@zh/shared';
import type { ExecError } from './tool-output-types';

/** 统一构造 `ToolResult.metadata`（version / duration / timestamp / fileCount 到处重复）。 */
export function scanMeta(start: number, fileCount: number): ToolResult['metadata'] {
  return { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount };
}

/** 各 CLI 适配器共用的「工具是否可用」判定：项目本地 → ~/.zhshield/bin → PATH。 */
export async function isToolAvailable(toolId: string): Promise<boolean> {
  const { origin } = await resolveToolCommandDetailed(toolId);
  return origin !== 'unresolved';
}

/**
 * 标准错误结果构造：ENOENT→unavailable；有部分输出→available；否则→error。
 * grype / semgrep 的错误分支此前逐字重复，抽出统一（部分输出解析由调用方注入）。
 */
export function buildStandardErrorResult(
  tool: ToolResult['tool'],
  start: number,
  err: ExecError,
  opts: {
    unavailableHint: string;
    failureMessage: string;
    parsePartial?: (stdout: string | undefined) => Issue[] | null;
  },
): ToolResult {
  if (err.code === 'ENOENT') {
    return {
      tool,
      status: 'unavailable',
      issues: [],
      metadata: scanMeta(start, 0),
      error: opts.unavailableHint,
    };
  }
  const partialIssues = opts.parsePartial?.(err.stdout) ?? null;
  if (partialIssues) {
    return {
      tool,
      status: 'available',
      issues: partialIssues,
      metadata: scanMeta(start, partialIssues.length),
    };
  }
  return {
    tool,
    status: 'error',
    issues: [],
    metadata: scanMeta(start, 0),
    error: err.stderr || err.message || opts.failureMessage,
  };
}
