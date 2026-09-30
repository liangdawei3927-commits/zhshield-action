import type { PerformanceReportData } from '../types/electron';
import { SEVERITY_CONFIG } from './performance-logic';
import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import { SeverityBadge } from '../components/ui/SeverityBadge';

function IssueCard({
  issue,
  onCopyToAi,
}: {
  issue: PerformanceReportData['issues'][number];
  onCopyToAi: (issue: PerformanceReportData['issues'][number]) => void;
}) {
  const t = useT();
  const cfg = SEVERITY_CONFIG[issue.severity] ?? SEVERITY_CONFIG.low;
  return (
    <ResultCard>
      <div className="flex items-center gap-3">
        <SeverityBadge bg={cfg.bg} color={cfg.color} label={t(cfg.textKey)} />
        <span className="text-sm font-medium text-zh-ink-2">{issue.ruleId}</span>
        {issue.autoFixable && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium text-success-800 bg-success-50">
            {t('page.performance.autoFixable')}
          </span>
        )}
        <CopyToAiButton className="ml-auto" onClick={() => onCopyToAi(issue)} />
      </div>
      <div className="mt-2 text-xs text-zh-muted">
        {issue.file}
        {issue.line != null ? `:${issue.line}` : ''}
      </div>
      <div className="mt-1 text-xs text-zh-muted">{issue.message}</div>
      {issue.suggestion && (
        <div className="mt-1 text-xs text-info-500">
          {t('page.performance.suggestion', { suggestion: issue.suggestion })}
        </div>
      )}
    </ResultCard>
  );
}

export function IssuesPanel({
  issues,
  onCopyToAi,
  onCopyAll,
}: {
  issues: PerformanceReportData['issues'];
  onCopyToAi: (issue: PerformanceReportData['issues'][number]) => void;
  onCopyAll: () => void;
}) {
  const t = useT();
  return (
    <div>
      {issues.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-zh-muted">
            {t('page.performance.copyAllHint', { count: issues.length })}
          </span>
          <CopyAllToAiButton onClick={onCopyAll} />
        </div>
      )}
      <div className="space-y-3">
        {issues.map((issue) => (
          <IssueCard key={issue.id} issue={issue} onCopyToAi={onCopyToAi} />
        ))}
        {issues.length === 0 && (
          <div className="rounded-xl flex flex-col items-center justify-center py-16 gap-2 bg-zh-panel border border-dashed border-zh-line">
            <span className="text-2xl">✅</span>
            <span className="text-sm font-medium text-success-700">
              {t('page.performance.noIssues')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
