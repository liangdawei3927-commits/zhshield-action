import type { HealthScoreData } from '../types/electron';
import {
  getScoreColor,
  getScoreLabel,
  dimensionName,
  gradeLabel,
  type HealthScoreRow,
} from './reports-logic';
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
        <div className="flex flex-wrap gap-1.5">
          {item.dimensions.map((d, j) => (
            <span
              key={j}
              className="inline-flex items-baseline gap-1 text-xs px-1.5 py-0.5 rounded bg-zh-panel"
              style={{ color: getScoreColor(d.score) }}
              title={getScoreLabel(d.score)}
            >
              <span className="text-zh-muted">{dimensionName(d.name, t)}</span>
              <span className="font-bold">{d.score}</span>
              <span className="text-[10px] opacity-70">{getScoreLabel(d.score)}</span>
            </span>
          ))}
        </div>
      </td>
      <td className="px-5 py-3 text-right text-xs text-zh-muted">
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded font-medium"
          style={{
            color: getScoreColor(item.score),
            background: `color-mix(in srgb, ${getScoreColor(item.score)} 10%, transparent)`,
          }}
        >
          {gradeLabel(item.summary, t)}
        </span>
      </td>
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
