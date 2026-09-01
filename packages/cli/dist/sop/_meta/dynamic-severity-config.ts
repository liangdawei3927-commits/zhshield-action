import type { SopRule, Severity } from './sop-types';
import { SEVERITY_RANK, severityRank } from './adaptive-severity';

const DEFAULT_ACCUMULATION_THRESHOLD = 3;

const ACCUMULATION_POLICY_KEYS = new Set(['threshold', 'escalateTo', 'window']);

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && SEVERITY_RANK.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** F1：规则动态严重级配置非法 — 加载期快速失败，绝不静默跳过 */
export class SopRuleConfigError extends Error {
  constructor(ruleId: string, detail: string) {
    super(`[SopLoader] Rule "${ruleId}" 配置非法: ${detail}`);
    this.name = 'SopRuleConfigError';
  }
}

function parsePositiveInt(value: unknown, field: string, ruleId: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new SopRuleConfigError(ruleId, `${field} 必须是正整数，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

function parseAccumulationPolicy(
  value: unknown,
  ruleId: string,
): NonNullable<SopRule['accumulationPolicy']> {
  if (!isPlainObject(value)) {
    throw new SopRuleConfigError(
      ruleId,
      `accumulationPolicy/accumulate 必须是键值对象，实际为 ${JSON.stringify(value)}`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!ACCUMULATION_POLICY_KEYS.has(key)) {
      console.warn(`[SopLoader] Rule "${ruleId}": accumulationPolicy 含未知字段 "${key}"，已忽略`);
    }
  }
  if (!isSeverity(value.escalateTo)) {
    throw new SopRuleConfigError(
      ruleId,
      `accumulationPolicy.escalateTo 必须是合法 Severity(${[...SEVERITY_RANK.keys()].join('/')})，实际为 ${JSON.stringify(value.escalateTo)}`,
    );
  }
  const threshold =
    parsePositiveInt(value.threshold, 'accumulationPolicy.threshold', ruleId) ??
    DEFAULT_ACCUMULATION_THRESHOLD;
  const window = parsePositiveInt(value.window, 'accumulationPolicy.window', ruleId);
  return { threshold, escalateTo: value.escalateTo, ...(window !== undefined ? { window } : {}) };
}

function parseBlockingThreshold(value: unknown, ruleId: string): Severity | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isSeverity(value)) {
    throw new SopRuleConfigError(
      ruleId,
      `blockingThreshold 必须是合法 Severity(${[...SEVERITY_RANK.keys()].join('/')})或缺省，实际为 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** F1：从规则文档根解析动态严重级声明（accumulationPolicy|accumulate + blockingThreshold），
 *  并校验 escalateTo 严格高于静态 severity；无声明返回空对象（不改变现状）。 */
export function parseDynamicSeverityConfig(
  parsed: Record<string, unknown>,
  staticSeverity: string,
  ruleId: string,
): Pick<SopRule, 'accumulationPolicy' | 'blockingThreshold'> {
  const result: Pick<SopRule, 'accumulationPolicy' | 'blockingThreshold'> = {};
  const rawPolicy = parsed.accumulationPolicy ?? parsed.accumulate;
  if (rawPolicy !== undefined && rawPolicy !== null) {
    const policy = parseAccumulationPolicy(rawPolicy, ruleId);
    if (severityRank(policy.escalateTo) <= severityRank(staticSeverity)) {
      throw new SopRuleConfigError(
        ruleId,
        `accumulationPolicy.escalateTo("${policy.escalateTo}") 必须高于静态 severity("${staticSeverity}")`,
      );
    }
    result.accumulationPolicy = policy;
  }
  const blockingThreshold = parseBlockingThreshold(parsed.blockingThreshold, ruleId);
  if (blockingThreshold !== undefined) {
    result.blockingThreshold = blockingThreshold;
  }
  return result;
}
