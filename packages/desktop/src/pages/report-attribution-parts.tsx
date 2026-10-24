/**
 * 「分数变化归因」区块：把 -9.7 分拆成「哪几个域掉的」。
 *
 * 只做展示，数学全在 `report-attribution.ts`（已单测钉住恒等式）。
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
  contributionShare,
  indexRecordsByTimestamp,
  isStructureDominated,
  totalAbsolutePoints,
  type AttributionBreakdown,
  type AttributionResult,
  type AttributionUnavailable,
} from './report-attribution';
import { deltaColor, dimensionName, formatDelta, getScoreColor } from './reports-logic';
import { ResultCard } from '../components/ui/ResultCard';
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

function unavailableMessage(reason: AttributionUnavailable): string {
  switch (reason) {
    case 'version-mismatch':
      return '这两次记录来自不同评分算法版本，维度构成与扣分口径都变了，分数不能直接相减，因此不做归因。';
    case 'dimension-set-mismatch':
      return '这两次记录的维度构成不同（某些维度只在其中一次里存在），无法逐域对齐，因此不做归因。';
    case 'missing-weight':
      return '该记录缺少维度权重信息，无法计算各域贡献。刷新一次检查后新记录会带上权重。';
    case 'no-active-dimension':
      return '其中一次没有任何已检测的域（全部未运行），无法在加权口径下比较。';
  }
}

/** 一串「维度名 + 贡献值」chip */
function DomainChips({
  domains,
  emptyLabel,
}: {
  domains: readonly { name: string; points: number }[];
  emptyLabel: string;
}) {
  const t = useT();
  if (domains.length === 0) {
    return <span className="text-[11px] text-zh-muted">{emptyLabel}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {domains.map((domain) => (
        <span key={domain.name} className="inline-flex items-baseline gap-1 text-[11px]">
          <span className="text-zh-muted">{dimensionName(domain.name, t)}</span>
          <span className="font-bold" style={{ color: deltaColor(domain.points) }}>
            {formatDelta(domain.points)}
          </span>
        </span>
      ))}
    </span>
  );
}

/** 单域一行：上期 / 本期 / 域内变化 / 有效权重 / 贡献分 / 占比条 */
function DomainRow({
  domain,
  share,
}: {
  domain: AttributionBreakdown['domains'][number];
  share: number;
}) {
  const t = useT();
  return (
    <tr className="border-b border-zh-line last:border-0">
      <td className="px-4 py-2 text-xs text-zh-text">{dimensionName(domain.name, t)}</td>
      <td className="px-4 py-2 text-xs text-zh-muted font-mono">{domain.startScore}</td>
      <td className="px-4 py-2 text-xs font-mono" style={{ color: getScoreColor(domain.endScore) }}>
        {domain.endScore}
      </td>
      <td className="px-4 py-2 text-xs font-bold" style={{ color: deltaColor(domain.delta) }}>
        {formatDelta(domain.delta)}
      </td>
      <td className="px-4 py-2 text-xs text-zh-muted font-mono">
        {Math.round(domain.effectiveWeight * 1000) / 10}%
      </td>
      <td className="px-4 py-2 text-sm font-bold" style={{ color: deltaColor(domain.points) }}>
        {formatDelta(domain.points)}
      </td>
      <td className="px-4 py-2">
        <div
          className="h-1.5 w-20 rounded-full overflow-hidden"
          style={{ background: 'rgb(var(--zh-line))' }}
          title={`${Math.round(share * 100)}%`}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.round(share * 100)}%`,
              background: deltaColor(domain.points),
            }}
          />
        </div>
      </td>
    </tr>
  );
}

/** 口径类项目（结构项 / 封顶项）单独成行，提示它不属于任何单一域 */
function StructuralRow({
  label,
  hint,
  points,
}: {
  label: string;
  hint: string;
  points: number;
}) {
  return (
    <tr className="border-b border-zh-line" style={{ background: 'rgb(var(--zh-panel))' }}>
      <td className="px-4 py-2 text-xs text-zh-text">
        {label}
        <span className="ml-2 text-[10px] text-zh-muted">{hint}</span>
      </td>
      <td className="px-4 py-2 text-xs text-zh-muted" colSpan={4}>
        —
      </td>
      <td className="px-4 py-2 text-sm font-bold" style={{ color: deltaColor(points) }}>
        {formatDelta(points)}
      </td>
      <td className="px-4 py-2" />
    </tr>
  );
}

/**
 * 对账条：域贡献 + 结构项 + 封顶项 = 实际变化。
 *
 * 这一行是整块的可信度锚点。对不上必须标红 —— 一个能自证的归因才有资格被拿去改代码。
 */
function ReconcileBar({ result }: { result: AttributionBreakdown }) {
  const t = useT();
  const parts: Array<{ key: string; label: string; value: number }> = [
    { key: 'domains', label: t('page.reports.attribution.part.domains', { defaultValue: '域贡献' }), value: result.domainsPoints },
  ];
  if (Math.abs(result.structurePoints) >= 0.01) {
    parts.push({ key: 'structure', label: t('page.reports.attribution.part.structure', { defaultValue: '结构项' }), value: result.structurePoints });
  }
  if (Math.abs(result.capPoints) >= 0.01) {
    parts.push({ key: 'cap', label: t('page.reports.attribution.part.cap', { defaultValue: '封顶项' }), value: result.capPoints });
  }
  const sum = parts.reduce((acc, part) => acc + part.value, 0);
  const ok = result.reconciled;
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-[11px]"
      style={{
        background: ok ? 'rgb(var(--zh-panel))' : 'rgb(var(--zh-danger) / 0.08)',
        border: `1px solid ${ok ? 'rgb(var(--zh-line))' : 'rgb(var(--zh-danger) / 0.35)'}`,
      }}
    >
      {parts.map((part, index) => (
        <span key={part.key} className="inline-flex items-baseline gap-1">
          {index > 0 && <span className="text-zh-muted">+</span>}
          <span className="text-zh-muted">{part.label}</span>
          <span className="font-bold font-mono" style={{ color: deltaColor(part.value) }}>
            {formatDelta(part.value)}
          </span>
        </span>
      ))}
      <span className="text-zh-muted">=</span>
      <span className="font-bold font-mono text-zh-text">{formatDelta(Math.round(sum * 100) / 100)}</span>
      <span className="text-zh-muted">
        {t('page.reports.attribution.real', { defaultValue: '实际' })}
      </span>
      <span className="font-bold font-mono" style={{ color: deltaColor(result.exactDelta) }}>
        {formatDelta(result.exactDelta)}
      </span>
      <span
        className="font-bold"
        style={{ color: ok ? 'rgb(var(--zh-success))' : 'rgb(var(--zh-danger))' }}
      >
        {ok
          ? t('page.reports.attribution.reconciled', { defaultValue: '✓ 已对账' })
          : t('page.reports.attribution.unreconciled', {
              defaultValue: '✗ 归因未闭合（残差 {{residual}} 分），不要据此判断',
              residual: result.residual,
            })}
      </span>
    </div>
  );
}

/**
 * 「口径主导」警示条。
 *
 * 实测真实数据必现：`83.8 → 89.98（+6.2）` 那一次，域贡献全为 0，
 * 6.18 全部来自「参与域从 5 个变成 10 个」—— 分数涨了，但没有任何域变好。
 * 不点明的话，用户会把它当成改进成果。
 */
function StructureDominatedWarning({ result }: { result: AttributionBreakdown }) {
  const t = useT();
  return (
    <div
      className="mb-3 rounded-md px-3 py-2 text-[11px] leading-relaxed"
      style={{
        background: 'rgb(var(--zh-warning) / 0.08)',
        border: '1px solid rgb(var(--zh-warning) / 0.35)',
        color: 'rgb(var(--zh-text))',
      }}
    >
      {t('page.reports.attribution.structureDominated', {
        defaultValue:
          '本次 {{delta}} 分的变化里有 {{structure}} 分来自参与加权的域数量变化（{{from}} 个 → {{to}} 个），不是任何域真的变好或变差。把它当成改进或退步会得出错误结论。',
        delta: formatDelta(result.actualDelta),
        structure: formatDelta(result.structurePoints),
        from: result.activeStart,
        to: result.activeEnd,
      })}
    </div>
  );
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
      <div className="flex items-center justify-between mb-3 gap-3">
        <h2 className="text-base font-bold text-zh-text">
          {t('page.reports.attribution.title', { defaultValue: '分数变化归因' })}
        </h2>
        <select
          value={active}
          onChange={(event) => setSelected(event.target.value)}
          className="text-xs rounded-md px-2 py-1.5 bg-zh-panel text-zh-text"
          style={{ border: '1px solid rgb(var(--zh-line))' }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {headline && <p className="mb-2 text-xs text-zh-muted">{headline}</p>}

      {breakdown && (
        <>
          {isStructureDominated(breakdown) && <StructureDominatedWarning result={breakdown} />}
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3 text-xs">
            <span className="text-zh-muted">
              {t('page.reports.attribution.total', { defaultValue: '本期变化' })}{' '}
              <span
                className="font-bold text-sm"
                style={{ color: deltaColor(breakdown.actualDelta) }}
              >
                {formatDelta(breakdown.actualDelta)}
              </span>
              <span className="text-zh-muted">
                {' '}
                ({breakdown.startScore} → {breakdown.endScore})
              </span>
            </span>
            <span className="inline-flex items-baseline gap-1">
              <span className="text-zh-muted">
                {t('page.reports.attribution.dragDown', { defaultValue: '拉低' })}
              </span>
              <DomainChips
                domains={drops}
                emptyLabel={t('page.reports.attribution.none', { defaultValue: '无' })}
              />
            </span>
            <span className="inline-flex items-baseline gap-1">
              <span className="text-zh-muted">
                {t('page.reports.attribution.dragUp', { defaultValue: '拉高' })}
              </span>
              <DomainChips
                domains={rises}
                emptyLabel={t('page.reports.attribution.none', { defaultValue: '无' })}
              />
            </span>
          </div>

          <ResultCard variant="list" className="overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zh-panel">
                  <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
                    {t('page.reports.attribution.col.domain', { defaultValue: '维度' })}
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
                    {t('page.reports.attribution.col.start', { defaultValue: '上期分' })}
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
                    {t('page.reports.attribution.col.end', { defaultValue: '本期分' })}
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
                    {t('page.reports.attribution.col.delta', { defaultValue: '域内变化' })}
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
                    {t('page.reports.attribution.col.weight', { defaultValue: '有效权重' })}
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
                    {t('page.reports.attribution.col.points', { defaultValue: '贡献总分' })}
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
                    {t('page.reports.attribution.col.share', { defaultValue: '占比' })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {changed.map((domain) => (
                  <DomainRow
                    key={domain.name}
                    domain={domain}
                    share={contributionShare(domain.points, total)}
                  />
                ))}
                {changed.length === 0 && (
                  <tr>
                    <td className="px-4 py-3 text-xs text-zh-muted" colSpan={7}>
                      {t('page.reports.attribution.allFlat', {
                        defaultValue: '各域分数都没有实质变化（变化均小于 0.01 分）。',
                      })}
                    </td>
                  </tr>
                )}
                {Math.abs(breakdown.structurePoints) >= 0.01 && (
                  <StructuralRow
                    label={t('page.reports.attribution.structure', { defaultValue: '结构项（口径变化）' })}
                    hint={[
                      t('page.reports.attribution.activeShift', {
                        defaultValue: '参与域 {{from}} → {{to}}',
                        from: breakdown.activeStart,
                        to: breakdown.activeEnd,
                      }),
                      breakdown.entered.length > 0
                        ? t('page.reports.attribution.entered', {
                            defaultValue: '新增参与：{{list}}',
                            list: breakdown.entered.map((name) => dimensionName(name, t)).join('、'),
                          })
                        : '',
                      breakdown.exited.length > 0
                        ? t('page.reports.attribution.exited', {
                            defaultValue: '退出参与：{{list}}',
                            list: breakdown.exited.map((name) => dimensionName(name, t)).join('、'),
                          })
                        : '',
                      breakdown.weightChanged.length > 0
                        ? t('page.reports.attribution.weightChanged', {
                            defaultValue: '权重调整：{{list}}',
                            list: breakdown.weightChanged.map((name) => dimensionName(name, t)).join('、'),
                          })
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    points={breakdown.structurePoints}
                  />
                )}
                {Math.abs(breakdown.capPoints) >= 0.01 && (
                  <StructuralRow
                    label={t('page.reports.attribution.cap', { defaultValue: '封顶项（红线压制）' })}
                    hint={t('page.reports.attribution.capHint', {
                      defaultValue: '未封顶应为 {{raw}} 分，实际记为 {{actual}} 分',
                      raw: breakdown.rawEndScore,
                      actual: breakdown.endScore,
                    })}
                    points={breakdown.capPoints}
                  />
                )}
              </tbody>
            </table>
          </ResultCard>

          <ReconcileBar result={breakdown} />

          <p className="mt-2 text-[11px] text-zh-muted">
            {t('page.reports.attribution.note', {
              defaultValue:
                '贡献总分 = 域内变化 × 有效权重。有效权重按「本次参与加权的域」归一化：只跑了 9 个域时每域约 11.1%，而不是配置里的 10%，所以同样的跌幅会更明显地影响总分。',
            })}
          </p>
        </>
      )}
    </div>
  );
}
