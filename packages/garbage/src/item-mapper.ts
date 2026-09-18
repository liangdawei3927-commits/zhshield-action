/**
 * SOP 规则产出 → 垃圾项 的映射（唯一映射家）
 *
 * 垃圾清理域的 SOP 规则（garbage/scan/cleanup/*.yml）只负责"判定"，
 * 产出统一的 Issue[]；本文件把它们登记为页面上可读的 GarbageItem。
 * 新增规则必须在此登记 —— 未登记的规则产出会被显式丢弃并计入 checks，
 * 不会静默丢失（测试 sop-garbage-rules-mapped 锁定此约束）。
 */
import { randomUUID } from 'node:crypto';
import type { GarbageItem } from './types';

/** 规则 id → 垃圾类型。键必须与 garbage/scan/cleanup/*.yml 的 metadata.id 完全一致 */
export const GARBAGE_RULE_TYPE_MAP: Readonly<Record<string, GarbageItem['type']>> = {
  'garbage.scan.cleanup.dead-code': 'dead-code',
  'garbage.scan.cleanup.duplicate-code': 'duplicate-code',
  'garbage.scan.cleanup.unused-dependency': 'unused-dependency',
};

/** 规则产出的最小结构化字段（避免本包依赖 kernel 类型） */
export interface GarbageViolationLike {
  id?: string;
  ruleId: string;
  file?: string;
  line?: number;
  message?: string;
  suggestion?: string;
}

/** 规则 id 是否已在映射表登记 */
export function isGarbageRuleMapped(ruleId: string): boolean {
  return ruleId in GARBAGE_RULE_TYPE_MAP;
}

/** 单条规则 id → 垃圾类型；未登记返回 null（调用方须显式处理，不得静默丢弃） */
export function mapRuleIdToGarbageType(ruleId: string): GarbageItem['type'] | null {
  return GARBAGE_RULE_TYPE_MAP[ruleId] ?? null;
}

/** 把规则的违规条目转成垃圾项（未登记规则的条目由调用方另行处理） */
export function issuesToGarbageItems(issues: GarbageViolationLike[]): GarbageItem[] {
  const items: GarbageItem[] = [];
  for (const issue of issues) {
    const type = mapRuleIdToGarbageType(issue.ruleId);
    if (type === null) continue;
    items.push({
      id: issue.id || randomUUID(),
      type,
      path: issue.file || '',
      size: 0,
      reason: issue.message || issue.ruleId,
    });
  }
  return items;
}
