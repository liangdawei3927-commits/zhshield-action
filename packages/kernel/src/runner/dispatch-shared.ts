import { withHardTimeout } from '@zh/shared';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleEvaluation } from '../sop/_meta/rule-evaluation';

// ─── 派发评估：共享辅助 ────────────────────────────────

/** 从 unknown 类型的 catch 错误中安全提取 message */
export function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** tool-dispatch 单次工具扫描硬上限缺省值（ms）：2 分钟对大型 monorepo（20+ 包）不足，提至 5 分钟 */
export const DEFAULT_TOOL_SCAN_TIMEOUT_MS = 300_000;

/**
 * 硬上限保护：即便适配器未遵守 timeout（进程未退出），单次工具扫描也绝不
 * 无限挂起整个体检。超时即 reject，由 executeToolScan 的 catch 降级为该规则 error。
 */
export function withToolScanHardTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolId: string,
): Promise<T> {
  return withHardTimeout(promise, ms, `[sop] 工具 ${toolId} 扫描超过 ${ms}ms 硬上限，已跳过`);
}

export function errorResult(
  rule: SopRule,
  message: string,
  targetEngine: 'guard' | 'inspect',
): RuleEvaluation {
  return { rule, status: 'error', message, durationMs: 0, targetEngine, timestamp: new Date() };
}

export function targetEngineOf(rule: SopRule): 'guard' | 'inspect' {
  return rule.domain === 'guard' ? 'guard' : 'inspect';
}
