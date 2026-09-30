/**
 * 红线封顶（十域评分章程：critical 一票压制）。
 *
 * 纯平均会掩盖致命问题：9 个域 95 分 + 1 个 critical 密钥泄露 ≈ 95.5 分绿色，
 * 这在安全产品上不可接受。任一 critical 事实存在时总评强制封顶。
 *
 * 注意：普通「某域不及格」**不**触发封顶——总分 80 + 部分域不及格是合法状态，
 * 域分负责精确定位问题，总评只对致命风险一票压制。
 */
import type { DimensionExtras, RedLineInfo, RedLineReason } from './types';

/** 红线封顶上限：存在任一 critical 事实时总评 ≤ 55（<60 强制落入 D 级红色区间） */
export const RED_LINE_CAP = 55;

/** 评分算法版本：3 = 十域聚合 + 红线封顶 + quality 维规则聚合封顶(S1) + ESLOC 密度归一化(S2)；跨版本分数不做直接对比（前端只提示不比较） */
export const SCORE_VERSION = 3;

/**
 * 由扩展域原始数据判定红线事实。数据在 extras 里各域独立持有，
 * 故封顶判定在此处（buildHealthDimensions 消费方）完成，而非 calculate 内部。
 * 无红线事实时返回 null（HealthScore.redLine 保持 undefined）。
 */
export function computeRedLine(extras: DimensionExtras | undefined): RedLineInfo | null {
  if (!extras) return null;
  const reasons = [
    activeSecretsReason(extras),
    criticalVulnsReason(extras),
    criticalEventsReason(extras),
  ].filter((r): r is RedLineReason => r !== undefined);
  if (reasons.length === 0) return null;
  return { capped: true, cap: RED_LINE_CAP, reasons };
}

function activeSecretsReason(extras: DimensionExtras): RedLineReason | undefined {
  const activeSecrets = extras.secrets?.activeCount ?? 0;
  if (activeSecrets > 0) return { domain: 'security', kind: 'activeSecrets', count: activeSecrets };
  return undefined;
}

function criticalVulnsReason(extras: DimensionExtras): RedLineReason | undefined {
  const criticalVulns = extras.deps?.vulnerabilities?.critical ?? 0;
  if (criticalVulns > 0) {
    return { domain: 'dependencies', kind: 'criticalVulns', count: criticalVulns };
  }
  return undefined;
}

function criticalEventsReason(extras: DimensionExtras): RedLineReason | undefined {
  const criticalEvents = extras.sentinel?.criticalEvents ?? 0;
  if (criticalEvents > 0) {
    return { domain: 'sentinel', kind: 'criticalEvents', count: criticalEvents };
  }
  return undefined;
}
