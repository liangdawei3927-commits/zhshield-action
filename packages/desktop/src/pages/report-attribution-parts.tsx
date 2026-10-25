/**
 * 「分数变化归因」区块：把 -9.7 分拆成「哪几个域掉的」。
 *
 * 只做展示，数学全在 `report-attribution.ts`（已单测钉住恒等式）；
 * 表格行 / 汇总 / 对账条等展示块在 `report-attribution-blocks.tsx`（本文件超
 * 400 行代码阈值后按职责拆出）。
 *
 * 三条显示纪律：
 * - **对不上账就明说**：三项相加必须等于实际变化，不成立时标红告警并禁止读者据此行动，
 *   绝不四舍五入掩盖；
 * - **算不了就说算不了**：跨评分版本 / 缺权重显示原因，不显示一张全是 0 的表；
 * - **口径变化单独成行**：参与域从 9 变 10 导致的分差不是任何域变好坏造成的，
 *   不能摊给某个域（摊了就是编造）。
 */

import { useMemo, useState } from 'react';
import type { HealthScoreData } from '../types/electron';
import type { WindowBucket } from './report-windows';
import {
  attributeRange,
  attributeWindowVsPrev,
  indexRecordsByTimestamp,
  isStructureDominated,
  totalAbsolutePoints,
  type AttributionResult,
} from './report-attribution';
import {
  AttributionHeader,
  AttributionNote,
  AttributionSummary,
  ReconcileBar,
  StructureDominatedWarning,
  unavailableMessage,
} from './report-attribution-blocks';
import { AttributionTable } from './report-attribution-table';
import { useT } from '../i18n';

/** 只有 1 个窗口时无法比较，整块不渲染 */
const RANGE_VALUE = 'range';

/** 进结论句的最小贡献（分）。低于此值的项只留在表格里，不占结论版面 */
const CHIP_MIN_POINTS = 0.05;

/** 选项：区间总变化 + 每个「较上期」 */
export function attributionOptions(
  buckets: readonly WindowBucket[],
): Array<{ value: string; label: string }> {
  if (buckets.length < 2) return [];
  const first = buckets[0];
  // 上面已保证至少 2 个窗口，`?? first` 只是给 at() 的 `undefined` 兜类型，不改变取值
  const last = buckets.at(-1) ?? first;
  const options = [{ value: RANGE_VALUE, label: `${first.label} → ${last.label}` }];
  for (let i = 1; i < buckets.length; i += 1) {
    options.push({
      value: buckets[i].key,
      label: `${buckets[i - 1].label} → ${buckets[i].label}`,
    });
  }
  return options;
}

/** 按选中的范围取归因结果；范围失效（记录缺失）返回 null */
export function resolveAttribution(
  value: string,
  buckets: readonly WindowBucket[],
  byTimestamp: ReadonlyMap<string, HealthScoreData>,
): AttributionResult | null {
  if (value === RANGE_VALUE) return attributeRange(buckets, byTimestamp);
  const index = buckets.findIndex((bucket) => bucket.key === value);
  if (index < 0) return null;
  return attributeWindowVsPrev(buckets, index, byTimestamp);
}

export function AttributionSection({
  data,
  buckets,
}: {
  data: readonly HealthScoreData[];
  buckets: readonly WindowBucket[];
}) {
  const t = useT();
  const [selected, setSelected] = useState<string>(RANGE_VALUE);
  const byTimestamp = useMemo(() => indexRecordsByTimestamp(data), [data]);
  const options = useMemo(() => attributionOptions(buckets), [buckets]);
  // 粒度切换后旧的窗口键可能已不存在 → 回落到区间
  const active = options.some((option) => option.value === selected) ? selected : RANGE_VALUE;
  const result = useMemo(
    () => resolveAttribution(active, buckets, byTimestamp),
    [active, buckets, byTimestamp],
  );

  if (buckets.length < 2) return null;

  const headline = (() => {
    if (!result) {
      return t('page.reports.attribution.noRecord', {
        defaultValue: '该区间缺少评分记录，无法拆解变化。',
      });
    }
    if (!result.ok) return unavailableMessage(result.reason);
    return null;
  })();

  const breakdown = result?.ok ? result : null;
  const total = breakdown ? totalAbsolutePoints(breakdown.domains) : 0;
  const changed = breakdown
    ? breakdown.domains.filter((domain) => Math.abs(domain.points) >= 0.01)
    : [];
  // 结论句只留够格看的项：-0.01 这种进结论只是噪声，表格里仍然保留
  const drops = changed
    .filter((domain) => domain.points <= -CHIP_MIN_POINTS)
    .slice(0, 3);
  const rises = changed
    .filter((domain) => domain.points >= CHIP_MIN_POINTS)
    .slice(0, 3);

  return (
    <div className="mt-6">
      <AttributionHeader active={active} options={options} onSelect={setSelected} />

      {headline && <p className="mb-2 text-xs text-zh-muted">{headline}</p>}

      {breakdown && (
        <>
          {isStructureDominated(breakdown) && <StructureDominatedWarning result={breakdown} />}
          <AttributionSummary breakdown={breakdown} drops={drops} rises={rises} />
          <AttributionTable breakdown={breakdown} changed={changed} total={total} />
          <ReconcileBar result={breakdown} />
          <AttributionNote />
        </>
      )}
    </div>
  );
}
