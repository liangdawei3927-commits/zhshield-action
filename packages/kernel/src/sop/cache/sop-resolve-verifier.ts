/**
 * SOP 规则清单校验器（sop-resolve-verifier.ts）
 *
 * T1 免维护同步的纯函数内核：
 * - computeRuleContentSha：规则稳定内容的 SHA-256（contentSha），排除计数器/时间戳等易变字段
 * - buildCurrentVersions：本地规则 → currentVersions 投影，供 POST /resolve/rules 差量比对
 * - verifyRuleManifest：本地规则 vs 云端生效清单的漂移检测（missing / shaMismatch / unexpected）
 * - needsHeal：是否需要触发自愈同步
 *
 * 全部为纯函数、不触网络——编排（调 /resolve/rules、触发 syncFromCloud 自愈）由
 * desktop 端 resolve-reconcile 承担，本模块保持可单测、可复用。
 */

import * as crypto from 'node:crypto';
import type { SopRule } from '../_meta/sop-types';

/** 云端 /resolve/rules 生效清单条目（与 resolve-api ResolveRulesResponse.rules 对齐的最小投影） */
export interface RuleManifestEntry {
  ruleId: string;
  version: string;
  /** 云端规则内容哈希（rule_scope.content_sha）；null 时跳过内容比对 */
  sha: string | null;
  source: string;
}

/** 清单漂移报告 */
export interface ResolveDriftReport {
  /** 云端生效清单条数 */
  expected: number;
  /** 本地活跃规则数 */
  active: number;
  /** 云端有、本地无 → 需补齐（触发自愈） */
  missing: string[];
  /** 双方都有但内容哈希不一致 → 内容漂移（触发自愈；云端 sha 为 null 时不比较） */
  shaMismatch: string[];
  /** 本地活跃、云端清单外 → 画像裁剪视角多出的（仅观测，不删不触发自愈） */
  unexpected: string[];
}

/**
 * 确定性序列化：对象键递归排序、跳过 undefined，保证同内容必同哈希。
 * 不用 JSON.stringify 直接序列化的原因：对象键序受插入顺序影响，跨端不保证一致。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * 规则稳定内容的 SHA-256（contentSha）。
 *
 * 仅纳入影响检查行为的稳定字段；falsePositiveCount / truePositiveCount /
 * lastUsedAt / createdAt / updatedAt 等本地易变字段一律排除——否则每次评估
 * 计数变化都会造成「假漂移」，触发无意义的全量重同步。
 */
export function computeRuleContentSha(rule: SopRule): string {
  const stable = {
    id: rule.id,
    name: rule.name,
    domain: rule.domain,
    action: rule.action,
    source: rule.source,
    description: rule.description,
    status: rule.status,
    severity: rule.severity,
    executionMode: rule.executionMode,
    accumulationPolicy: rule.accumulationPolicy ?? null,
    blockingThreshold: rule.blockingThreshold ?? null,
    applicableEngines: [...rule.applicableEngines].sort(),
    serves: rule.serves ?? null,
    content: rule.content ?? {},
    tags: [...rule.tags].sort(),
  };
  return crypto.createHash('sha256').update(stableStringify(stable)).digest('hex');
}

/** 本地规则 → currentVersions 投影（ruleId → contentSha），供 /resolve/rules 差量比对 */
export function buildCurrentVersions(rules: SopRule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    out[rule.id] = computeRuleContentSha(rule);
  }
  return out;
}

/** 本地规则 vs 云端生效清单的漂移检测（纯函数，不触网络） */
export function verifyRuleManifest(
  localRules: readonly SopRule[],
  manifest: readonly RuleManifestEntry[],
): ResolveDriftReport {
  const localById = new Map(localRules.map((r) => [r.id, r]));
  const manifestIds = new Set<string>();
  const missing: string[] = [];
  const shaMismatch: string[] = [];

  for (const entry of manifest) {
    manifestIds.add(entry.ruleId);
    const local = localById.get(entry.ruleId);
    if (!local) {
      missing.push(entry.ruleId);
      continue;
    }
    if (entry.sha && entry.sha !== computeRuleContentSha(local)) {
      shaMismatch.push(entry.ruleId);
    }
  }

  const unexpected = localRules.filter((r) => !manifestIds.has(r.id)).map((r) => r.id);
  return {
    expected: manifest.length,
    active: localRules.length,
    missing,
    shaMismatch,
    unexpected,
  };
}

/**
 * 是否需要自愈同步：清单缺失或内容漂移时触发（拉全量/增量补齐）。
 * unexpected 仅观测——本地多出的规则不因云端清单裁剪而删除，避免误删本地自定义规则。
 */
export function needsHeal(report: ResolveDriftReport): boolean {
  return report.missing.length > 0 || report.shaMismatch.length > 0;
}
