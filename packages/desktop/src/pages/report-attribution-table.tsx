/**
 * 「分数变化归因」的明细表：逐域一行 + 口径类行（结构项 / 封顶项）。
 *
 * 从 `report-attribution-parts.tsx` 经 `report-attribution-blocks.tsx` 再拆一层：
 * 表格是本区块里最大的一块 JSX，单独成文件后三个文件的行数都远离 400 行阈值。
 *
 * 只做渲染，不含任何数学（数学全在 `report-attribution.ts`）。
 */

import type { AttributionBreakdown } from './report-attribution';
import { contributionShare } from './report-attribution';
import { deltaColor, dimensionName, formatDelta, getScoreColor } from './reports-logic';
import { ResultCard } from '../components/ui/ResultCard';
import { useT } from '../i18n';

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

/** 结构项一行的口径说明：参与域变动 + 新增 / 退出 / 权重调整清单 */
function structuralHint(breakdown: AttributionBreakdown, t: ReturnType<typeof useT>): string {
  return [
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
    .join(' · ');
}

/** 口径类行：结构项 / 封顶项（分差绝对值 < 0.01 不占行） */
function AttributionStructureRows({ breakdown }: { breakdown: AttributionBreakdown }) {
  const t = useT();
  return (
    <>
      {Math.abs(breakdown.structurePoints) >= 0.01 && (
        <StructuralRow
          label={t('page.reports.attribution.structure', { defaultValue: '结构项（口径变化）' })}
          hint={structuralHint(breakdown, t)}
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
    </>
  );
}

/** 表头：7 列固定 */
function AttributionTableHead() {
  const t = useT();
  return (
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
  );
}

/** 归因明细表：逐域一行 + 口径类行（结构项 / 封顶项） */
export function AttributionTable({
  breakdown,
  changed,
  total,
}: {
  breakdown: AttributionBreakdown;
  changed: AttributionBreakdown['domains'];
  total: number;
}) {
  const t = useT();
  return (
    <ResultCard variant="list" className="overflow-hidden">
      <table className="w-full text-sm">
        <AttributionTableHead />
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
          <AttributionStructureRows breakdown={breakdown} />
        </tbody>
      </table>
    </ResultCard>
  );
}
