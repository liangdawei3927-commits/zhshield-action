// ─── 工具适配器装饰器（F0 Hook/Audit 地基 + F5 权限边界）────

import type { AccessScope, ToolAdapter, ToolCallHook, ToolResult, ToolScanOptions } from './types';
import { matchGlobPath } from './scope-matcher';

/** 携带 hookModifications 的扫描结果：调用点据此填充 AuditEntry.hookModifications */
export type HookedToolResult = ToolResult & {
  hookModifications?: string[];
  /** F5：越界访问记录（仅声明 accessScope 且确有越界时才存在；warn-only 不阻断） */
  scopeViolations?: ScopeViolation[];
};

/** F5：单条越界记录 */
export interface ScopeViolation {
  file: string;
  reason: string;
}

/** F5：越界回调上下文（options 携带 projectId 等扫描期信息） */
export interface ScopeViolationContext {
  adapter: ToolAdapter;
  options: ToolScanOptions;
}

export interface WrapAdapterOptions {
  /** 每条越界触发一次；仅声明了 accessScope 的适配器会触发 */
  onScopeViolation?: (violation: ScopeViolation, context: ScopeViolationContext) => void;
}

function createBlockedResult(adapter: ToolAdapter): HookedToolResult {
  return {
    tool: adapter.meta.id,
    status: 'skipped',
    issues: [],
    metadata: { version: '', duration: 0, timestamp: new Date(), fileCount: 0 },
    error: 'blocked-by-hook',
    hookModifications: ['before:blocked'],
  };
}

/**
 * F5：对 scan 入参 targetFiles 做边界校验（仅告警不阻断）。
 * 判定顺序：excludePaths 命中 → excluded-by-scope；未命中 readPaths → outside-read-paths；
 * 命中 sensitivePatterns → sensitive-path。未声明 readPaths 视为不限制读取范围。
 */
export function evaluateAccessScope(scope: AccessScope, options: ToolScanOptions): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  for (const file of options.targetFiles ?? []) {
    const excludeHit = (scope.excludePaths ?? []).find((p) => matchGlobPath(file, p));
    if (excludeHit !== undefined) {
      violations.push({ file, reason: `excluded-by-scope:${excludeHit}` });
      continue;
    }
    if ((scope.readPaths ?? []).length > 0
      && !(scope.readPaths as string[]).some((p) => matchGlobPath(file, p))) {
      violations.push({ file, reason: 'outside-read-paths' });
      continue;
    }
    const sensitiveHit = (scope.sensitivePatterns ?? []).find((p) => matchGlobPath(file, p));
    if (sensitiveHit !== undefined) {
      violations.push({ file, reason: `sensitive-path:${sensitiveHit}` });
    }
  }
  return violations;
}

/**
 * 包装适配器：scan 前依次执行 hooks 的 before（返回 null 即阻断，不触达真实扫描），
 * scan 后依次执行 after 并串联可能被改写的结果。纯函数、不落审计 —— 审计由调用点负责。
 * F5：声明了 accessScope 的适配器在 scan 前校验入参路径，越界仅记录/回调，扫描照常执行。
 */
export function wrapAdapter(
  adapter: ToolAdapter,
  hooks: ToolCallHook[] = [],
  options?: WrapAdapterOptions,
): ToolAdapter {
  return {
    ...adapter,
    async scan(scanOptions: ToolScanOptions): Promise<HookedToolResult> {
      let currentOptions = scanOptions;
      for (const hook of hooks) {
        const next = hook.before(adapter, currentOptions);
        if (next === null) {
          return createBlockedResult(adapter);
        }
        currentOptions = next;
      }

      const violations = adapter.accessScope
        ? evaluateAccessScope(adapter.accessScope, currentOptions)
        : [];
      const violationContext = { adapter, options: currentOptions };
      for (const violation of violations) {
        options?.onScopeViolation?.(violation, violationContext);
      }

      let currentResult: HookedToolResult = await adapter.scan(currentOptions);
      const modifications: string[] = [];
      for (const hook of hooks) {
        try {
          const next = hook.after(adapter, currentResult);
          if (next !== currentResult) {
            modifications.push('after:rewrote');
          }
          currentResult = next;
        } catch {
          // 钩子异常不得影响调用方：保留当前结果，继续执行后续钩子
        }
      }
      if (violations.length > 0 || modifications.length > 0) {
        return {
          ...currentResult,
          ...(modifications.length > 0 ? { hookModifications: modifications } : {}),
          ...(violations.length > 0 ? { scopeViolations: violations } : {}),
        };
      }
      return currentResult;
    },
  };
}
