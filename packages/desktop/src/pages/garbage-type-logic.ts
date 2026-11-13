/**
 * 垃圾类型维度的执行状态判定（纯函数，无 React 依赖，便于直接单测）。
 *
 * 存在意义：`summary.byType` 只统计条目——缺 key 与「查过且 0 条」长得一模一样，
 * 直接 `byType[type] ?? 0` 会把「没查」渲染成 0，违反 @zh/garbage types.ts 的诚实性约束
 * （未执行项必须显式提示，禁止静默当"通过"）。这里从 checks 的 `garbageTypes` 反查，
 * 把「未检测」与「查过且干净」两种状态分开。
 */
import type { GarbageScanReportData } from '../types/electron';

export interface GarbageTypeStates {
  /** 有检测项声明覆盖的类型（跑了或没跑都算覆盖） */
  covered: Set<string>;
  /** 因检测项未执行而必须标「未检测」的类型 → 未执行原因列表 */
  reasons: Map<string, string[]>;
}

/** 从报告的 checks 汇总各垃圾类型的覆盖与未执行原因 */
export function garbageTypeStates(report: GarbageScanReportData): GarbageTypeStates {
  const covered = new Set<string>();
  const reasons = new Map<string, string[]>();
  for (const check of report.checks) {
    for (const type of check.garbageTypes ?? []) {
      covered.add(type);
      if (check.ran) continue;
      const list = reasons.get(type) ?? [];
      list.push(check.reason || check.name);
      reasons.set(type, list);
    }
  }
  return { covered, reasons };
}

/**
 * 该维度是否「未检测」。
 *
 * 两种来源都算未检测：
 * 1. 覆盖它的检测项存在但没跑成功（工具缺失 / 项目前提不满足）；
 * 2. 本域根本没有覆盖该类型的检测项（如重复代码已按《07》O1 移交重构域）。
 * @param hasDeclaredTypes 报告是否声明了类型归属；历史快照等旧报告未声明时退回旧口径（不标未检测）
 */
export function isGarbageTypeUndetected(
  states: GarbageTypeStates,
  type: string,
  hasDeclaredTypes: boolean,
): boolean {
  if (states.reasons.has(type)) return true;
  return hasDeclaredTypes && !states.covered.has(type);
}
