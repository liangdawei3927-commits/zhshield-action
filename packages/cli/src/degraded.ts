/**
 * degraded-count — 从各形态引擎报告中提取「非预期降级」数量
 *
 * P0（复查4）：此前降级护栏只挂在 CLI 的 --sop 分支（cli/index.ts 的
 * `if (opts.sop)` 内），默认路径产出同样含 degraded 的报告却无人判定，
 * 造成隔离环境下 8 项检查全跳过仍「100 分 / A / 流水线通过 / exit 0」。
 *
 * 不变量：什么都没实际查 = 不得报通过。本模块是 CLI 四个命令
 * （guard/inspect/pipeline × sop/默认）共用的单一判定来源。
 */

/** 已知报告形态的降级信号字段（结构化鸭子类型，避免硬依赖运行时类型） */
interface DegradableReport {
  /** RuleEngineReport（SOP 直接产出）：顶层 degraded 计数 */
  degraded?: unknown;
  /** InspectionReport：adapterResults[].degraded === true 计数 */
  adapterResults?: unknown;
  /** GuardReport（非 SOP 门禁）：results + summary */
  results?: unknown;
  summary?: unknown;
}

/**
 * 提取报告中的非预期降级数量：
 * - RuleEngineReport → 顶层 degraded 数值；
 * - InspectionReport → adapterResults 中 degraded === true 的条目数；
 * - GuardReport → 零结果空跑（summary.total === 0）视为盲检，计 1；
 * - 其余形态（RefactorReport 等）→ 0。
 */
export function countDegraded(report: unknown): number {
  if (!report || typeof report !== 'object') return 0;
  const r = report as DegradableReport;
  if (typeof r.degraded === 'number') return r.degraded;
  if (Array.isArray(r.adapterResults)) {
    return (r.adapterResults as unknown[]).filter(
      (a) => !!a && typeof a === 'object' && (a as DegradableReport).degraded === true,
    ).length;
  }
  // GuardReport：没有任何检查结果 = 什么都没查，与规则 0 条同级盲检
  if (Array.isArray(r.results) && !!r.summary && typeof r.summary === 'object') {
    const total = (r.summary as { total?: unknown }).total;
    return total === 0 ? 1 : 0;
  }
  return 0;
}
