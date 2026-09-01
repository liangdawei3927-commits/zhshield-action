import type { HealthScoreData } from '../types/electron';
import { getScoreColor, getScoreLabel, type HealthScoreRow } from './reports-logic';
import { ResultCard } from '../components/ui/ResultCard';
import { useT } from '../i18n';

function HistoryRow({ item, isLast }: { item: HealthScoreRow; isLast: boolean }) {
  const t = useT();
  return (
    <tr className={isLast ? '' : 'border-b border-zh-line'}>
      <td className="px-5 py-3 font-mono text-xs text-zh-muted">
        {new Date(item.timestamp).toLocaleDateString()}
      </td>
      <td className="px-5 py-3">
        <span className="font-bold" style={{ color: getScoreColor(item.score) }}>
          {item.score}
        </span>
        <span className="text-xs ml-1 text-zh-muted">({getScoreLabel(item.score)})</span>
      </td>
      <td className="px-5 py-3">
        <span
          className="text-xs"
          style={{ color: item.score >= 60 ? 'rgb(var(--zh-success))' : 'rgb(var(--zh-danger))' }}
        >
          {item.score >= 60 ? t('page.reports.table.healthy') : t('page.reports.table.abnormal')}
        </span>
      </td>
      <td className="px-5 py-3">
        <div className="flex gap-2">
          {item.dimensions.slice(0, 3).map((d, j) => (
            <span key={j} className="text-xs px-1.5 py-0.5 rounded bg-zh-panel text-zh-muted">
              {d.name}: {d.score}
            </span>
          ))}
        </div>
      </td>
      <td className="px-5 py-3 text-right text-xs text-zh-muted">{item.summary}</td>
    </tr>
  );
}

export function HistoryTable({ data }: { data: HealthScoreData[] }) {
  const t = useT();
  return (
    <ResultCard variant="list" className="overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-zh-panel">
            <th className="text-left px-5 py-3 font-medium text-zh-muted">
              {t('page.reports.table.col.date')}
            </th>
            <th className="text-left px-5 py-3 font-medium text-zh-muted">
              {t('page.reports.table.col.score')}
            </th>
            <th className="text-left px-5 py-3 font-medium text-zh-muted">
              {t('page.reports.table.col.status')}
            </th>
            <th className="text-left px-5 py-3 font-medium text-zh-muted">
              {t('page.reports.table.col.dimension')}
            </th>
            <th className="text-right px-5 py-3 font-medium text-zh-muted">
              {t('page.reports.table.col.summary')}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.toReversed().map((item, i) => (
            <HistoryRow key={i} item={item} isLast={i === data.length - 1} />
          ))}
        </tbody>
      </table>
    </ResultCard>
  );
}
