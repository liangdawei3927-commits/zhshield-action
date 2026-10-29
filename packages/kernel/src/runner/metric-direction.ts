/**
 * 阈值方向约定（单点定义）。
 *
 * `threshold` 指令没有 direction 字段，方向只能由 `unit` 约定推断。
 * **新增单位必须在此登记**，否则会按「越大越差」比较，把覆盖率 90% 判成超标。
 *
 * 引擎内求值（`evalThreshold`）与扫描后门禁（`evaluatePostScanGates`）共用本模块，
 * 避免两处各写一份方向表 —— 两份必然漂移，届时同一条规则在两个阶段结论相反。
 */

/** 下限型度量单位：数值越高越好（覆盖率、评分）。其余按上限型处理（复杂度、行数、嵌套深度） */
export const LOWER_BOUND_UNITS: ReadonlySet<string> = new Set([
  'percent',
  'percentage',
  'ratio',
  'score',
]);

export function isLowerBoundUnit(unit: string | undefined): boolean {
  return unit !== undefined && LOWER_BOUND_UNITS.has(unit.toLowerCase());
}

/** 单次比较的结论：达标 / 越界 / 无法比较（缺值） */
export type MetricVerdict = 'met' | 'breached' | 'unknown';

/**
 * 实测值与阈值的比较（纯函数）。
 *
 * `unknown` 只表示**没有实测值**——调用方必须把它落成「未判定 + 原因」，
 * 绝不能当成 `met`：那正是「未检测 = 通过」的老毛病。
 */
export function compareMetric(
  actual: number | undefined,
  threshold: number,
  unit: string | undefined,
): MetricVerdict {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return 'unknown';
  const breached = isLowerBoundUnit(unit) ? actual < threshold : actual > threshold;
  return breached ? 'breached' : 'met';
}
