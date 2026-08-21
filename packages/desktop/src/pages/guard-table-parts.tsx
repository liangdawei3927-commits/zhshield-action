import type { GuardReportData } from '../types/electron';
import { useT } from '../i18n';
import { SEVERITY_LABELS, SEVERITY_COLORS, STATUS_LABELS } from './guard-logic';
import { Bounce } from '../components/ui/Bounce';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';

function GuardRow({ check, isLast, onCopyToAi, onReportFalsePositive }: { check: GuardReportData['checks'][number]; isLast: boolean; onCopyToAi: (check: GuardReportData['checks'][number]) => void; onReportFalsePositive: (check: GuardReportData['checks'][number]) => void }) {
  const t = useT();
  const st = STATUS_LABELS[check.status];
  const severity = check.severity ? t(SEVERITY_LABELS[check.severity] ?? check.severity) : '-';
  const sColor = check.severity ? SEVERITY_COLORS[check.severity] : { color: 'rgb(var(--zh-muted))', bg: 'rgb(var(--zh-muted) / 0.1)' };
  return (
    <tr key={check.id} className={isLast ? '' : 'border-b border-zh-line'}>
      <td className="px-5 py-3 font-medium text-zh-ink-2">{check.name}</td>
      <td className="px-5 py-3">
        {check.severity && (
          <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ background: sColor.bg, color: sColor.color }}>
            {severity}
          </span>
        )}
      </td>
      <td className="px-5 py-3">
        <span className="flex items-center gap-1.5 text-xs" style={{ color: st.color }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: st.color }} />
          {t(st.textKey)}
        </span>
      </td>
      <td className="px-5 py-3 text-right">
        <div className="flex flex-col items-end gap-1.5">
          <span className="text-xs text-zh-muted">{check.message}</span>
          {check.status !== 'pass' && (
            <div className="flex items-center gap-2">
              <CopyToAiButton onClick={() => onCopyToAi(check)} />
              <Bounce
                as="button"
                onClick={() => onReportFalsePositive(check)}
                className="px-2 py-0.5 rounded text-[11px] font-medium text-zh-ink-2 bg-zh-panel hover:bg-zh-line border-none cursor-pointer"
              >
                {t('page.guard.markFalsePositive')}
              </Bounce>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

export function GuardTable({ report, onCopyToAi, onCopyAll, onReportFalsePositive }: { report: GuardReportData; onCopyToAi: (check: GuardReportData['checks'][number]) => void; onCopyAll: (checks: GuardReportData['checks'][number][]) => void; onReportFalsePositive: (check: GuardReportData['checks'][number]) => void }) {
  const t = useT();
  const failedChecks = report.checks.filter((c) => c.status !== 'pass');
  return (
    <ResultCard variant="list" className="overflow-hidden">
      {failedChecks.length > 0 && (
    <div className="flex items-center justify-between px-5 py-3 border-b border-zh-line">
      <span className="text-xs text-zh-muted">{t('page.guard.copyAllPrompt', { count: failedChecks.length })}</span>
          <CopyAllToAiButton onClick={() => onCopyAll(failedChecks)} />
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-zh-panel">
            <th className="text-left px-5 py-3 font-medium text-zh-muted">{t('page.guard.table.colCheck')}</th>
            <th className="text-left px-5 py-3 font-medium text-zh-muted">{t('page.guard.table.colSeverity')}</th>
            <th className="text-left px-5 py-3 font-medium text-zh-muted">{t('page.guard.table.colResult')}</th>
            <th className="text-right px-5 py-3 font-medium text-zh-muted">{t('page.guard.table.colDetail')}</th>
          </tr>
        </thead>
        <tbody>
          {report.checks.map((check, i) => (
            <GuardRow key={check.id} check={check} isLast={i === report.checks.length - 1} onCopyToAi={onCopyToAi} onReportFalsePositive={onReportFalsePositive} />
          ))}
        </tbody>
      </table>
    </ResultCard>
  );
}
