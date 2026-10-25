/**
 * 分类页「历史记录」面板：每次检查一条，带相对上一次的涨跌与新增/修复。
 *
 * 为什么要它：`domains/<domain>.json` 是覆盖写，扫 10 次只剩最后 1 次 ——
 * 页面看上去和「扫 1 次」没区别，用户无法判断分数是刚才的还是上周的，
 * 也无法回答「这次为什么掉分」。这里把每一次摆出来，只读、不触发任何扫描。
 *
 * 诚实边界：
 * - 该域不出分（score === null）→ 显示「—」而不是 0；
 * - 首次扫描没有基线 → 变化列显示「无基线」，不编造涨跌；
 * - 没有历史记录 → 整块隐藏（不占位、不显示空表）。
 */

import { useT } from '../../i18n';
import { useDomainHistory } from '../../hooks/useDomainHistory';
import { ResultCard } from '../ui/ResultCard';
import { buildHistoryRows, deltaDirection, type HistoryRow } from '../../pages/domain-history-logic';

/** 变化配色：质量分上涨=好（success），下跌=差（danger），持平/无基线=muted */
const DELTA_COLOR: Record<ReturnType<typeof deltaDirection>, string> = {
  up: 'rgb(var(--zh-success))',
  down: 'rgb(var(--zh-danger))',
  flat: 'rgb(var(--zh-muted))',
};

function formatDelta(value: number): string {
  if (value === 0) return '0';
  return value > 0 ? `+${value}` : String(value);
}

function HistoryRowView({
  row,
  index,
  t,
}: {
  row: HistoryRow;
  index: number;
  t: ReturnType<typeof useT>;
}) {
  const { record, added, removed, scoreDelta } = row;
  const direction = deltaDirection(scoreDelta);
  const severityText =
    record.severityApplicable === false
      ? '—'
      : `${record.error}/${record.warning}/${record.info}`;

  return (
    <tr
      data-testid={`domain-history-row-${index}`}
      style={{ borderTop: index === 0 ? 'none' : '1px solid rgb(var(--zh-line))' }}
    >
      <td className="px-5 py-3 text-xs text-zh-muted whitespace-nowrap">
        {new Date(record.scannedAt).toLocaleString()}
      </td>
      <td className="px-5 py-3 text-sm font-bold text-zh-ink whitespace-nowrap">
        {record.score === null ? '—' : record.score}
      </td>
      <td className="px-5 py-3 text-sm text-zh-ink whitespace-nowrap">{record.total}</td>
      <td className="px-5 py-3 text-xs text-zh-muted whitespace-nowrap" title={t('page.domainHistory.severityHint', { defaultValue: '错误/警告/提示' })}>
        {severityText}
      </td>
      <td
        className="px-5 py-3 text-xs whitespace-nowrap font-medium"
        style={{ color: DELTA_COLOR[direction] }}
      >
        {scoreDelta === null
          ? t('page.domainHistory.noBaseline', { defaultValue: '无基线' })
          : scoreDelta === 0
            ? t('page.domainHistory.flat', { defaultValue: '持平' })
            : `${direction === 'up' ? '↑' : '↓'} ${formatDelta(scoreDelta)}`}
      </td>
      <td className="px-5 py-3 text-xs whitespace-nowrap">
        <span style={{ color: added > 0 ? 'rgb(var(--zh-danger))' : 'rgb(var(--zh-muted))' }}>
          +{added}
        </span>
        <span className="text-zh-muted mx-1">/</span>
        <span style={{ color: removed > 0 ? 'rgb(var(--zh-success))' : 'rgb(var(--zh-muted))' }}>
          -{removed}
        </span>
      </td>
    </tr>
  );
}

/** 历史表格：表头 + 数据行。与面板外壳（标题/脚注）分离，行渲染在 HistoryRowView */
function HistoryTable({
  rows,
  t,
}: {
  rows: HistoryRow[];
  t: ReturnType<typeof useT>;
}) {
  return (
    <table className="w-full text-left">
      <thead>
        <tr className="text-[11px] text-zh-muted">
          <th className="px-5 py-2 font-medium">
            {t('page.domainHistory.column.time', { defaultValue: '检查时间' })}
          </th>
          <th className="px-5 py-2 font-medium">
            {t('page.domainHistory.column.score', { defaultValue: '分数' })}
          </th>
          <th className="px-5 py-2 font-medium">
            {t('page.domainHistory.column.issues', { defaultValue: '问题数' })}
          </th>
          <th className="px-5 py-2 font-medium">
            {t('page.domainHistory.column.severity', { defaultValue: '错/警/提' })}
          </th>
          <th className="px-5 py-2 font-medium">
            {t('page.domainHistory.column.delta', { defaultValue: '较上次' })}
          </th>
          <th className="px-5 py-2 font-medium">
            {t('page.domainHistory.column.change', { defaultValue: '新增/修复' })}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <HistoryRowView key={row.record.scanId} row={row} index={index} t={t} />
        ))}
      </tbody>
    </table>
  );
}

export interface DomainHistoryPanelProps {
  projectPath: string;
  /** 域键（inspect/refactor/deps/…）；缺省不渲染 */
  domain?: string;
  /** 展示条数 */
  limit?: number;
}

export function DomainHistoryPanel({ projectPath, domain, limit }: DomainHistoryPanelProps) {
  const t = useT();
  const { records, loading } = useDomainHistory(projectPath, domain, limit);

  if (!domain || loading || records.length === 0) return null;
  const rows = buildHistoryRows(records);

  return (
    <section className="mt-6" data-testid="domain-history-panel">
      <div className="flex items-baseline gap-3 mb-3">
        <h2 className="text-lg font-bold text-zh-ink">
          {t('page.domainHistory.title', { defaultValue: '历史记录' })}
        </h2>
        <span className="text-xs text-zh-muted">
          {t('page.domainHistory.subtitle', {
            defaultValue: '最近 {{count}} 次检查，含分数涨跌与问题增减（新增 / 修复）',
            count: rows.length,
          })}
        </span>
      </div>
      <ResultCard variant="list" className="overflow-hidden">
        <HistoryTable rows={rows} t={t} />
      </ResultCard>
      <p className="mt-2 text-[11px] text-zh-muted">
        {records[0]?.backfilled
          ? t('page.domainHistory.backfilled', {
              defaultValue:
                '当前只有升级前保存的最近一次结果（无逐次历史）。再检查一次后，每次都会单独留下记录。',
            })
          : t('page.domainHistory.note', {
              defaultValue:
                '记录在 .zhshield/history/ 下，每次扫描追加一条；打开这个页面不会触发检查。',
            })}
      </p>
    </section>
  );
}
