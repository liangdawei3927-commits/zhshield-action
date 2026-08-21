import type { PerformanceReportData } from '../types/electron';
import { SEVERITY_CONFIG } from './performance-logic';
import { useT } from '../i18n';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';

/** 琥珀色闪电 SVG — 性能主题（线性风格） */
export function AmberBolt() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-warning) / 0.05)" />
      <circle cx="75" cy="75" r="55" fill="rgb(var(--zh-warning) / 0.03)" />
      {/* 闪电 */}
      <path d="M82 22L48 82h22l-8 46 40-64H78l8-42z" fill="rgb(var(--zh-warning) / 0.1)" stroke="rgb(var(--zh-warning))" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

export function PerformanceHeader({ report, loading, progressLabel, onRescan }: { report: PerformanceReportData; loading: boolean; progressLabel?: string; onRescan: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-8">
      <Bounce className="w-12 h-12 rounded-xl bg-amber-50 flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--zh-warning))" strokeWidth="1.8">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      </Bounce>
      <div>
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.performance.header.title')}</h1>
        <p className="text-sm text-zh-muted">{t('page.performance.header.issueCount', { count: report.summary.total })}</p>
      </div>
      <PrimaryButton className="ml-auto" onClick={onRescan} loading={loading} loadingLabel={progressLabel || t('page.performance.detecting')}>
        {t('page.performance.rescan')}
      </PrimaryButton>
    </div>
  );
}

export function PerformanceScoreCard({ report }: { report: PerformanceReportData }) {
  const t = useT();
  return (
    <ResultCard variant="score" className="flex items-center gap-6 mb-6">
      <div className="w-20 h-20 rounded-full flex items-center justify-center bg-amber-50 border-[3px] border-amber-500 shrink-0">
        <span className="text-2xl font-bold text-amber-500">
          {report.summary.total === 0 ? 100 : Math.max(0, Math.round((1 - report.summary.total / (report.summary.total + 20)) * 100))}
        </span>
      </div>
      <div>
        <div className="text-sm font-semibold text-zh-ink-2">{t('page.performance.score.health')}</div>
        <div className="flex gap-3 mt-2">
          <span className="text-xs flex items-center gap-1 text-amber-500">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />{t('page.performance.severity.medium')} {report.issues.filter(i => i.severity === 'medium').length}
          </span>
          <span className="text-xs flex items-center gap-1 text-blue-500">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />{t('page.performance.severity.low')} {report.issues.filter(i => i.severity === 'low').length}
          </span>
          <span className="text-xs flex items-center gap-1 text-green-700">
            <span className="w-1.5 h-1.5 rounded-full bg-green-700" />{t('page.performance.score.fixable', { count: report.summary.autoFixable })}
          </span>
        </div>
      </div>
    </ResultCard>
  );
}

function IssueCard({ issue, onCopyToAi }: { issue: PerformanceReportData['issues'][number]; onCopyToAi: (issue: PerformanceReportData['issues'][number]) => void }) {
  const t = useT();
  const cfg = SEVERITY_CONFIG[issue.severity] ?? SEVERITY_CONFIG.low;
  return (
    <ResultCard>
      <div className="flex items-center gap-3">
        <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ background: cfg.bg, color: cfg.color }}>
          {t(cfg.textKey)}
        </span>
        <span className="text-sm font-medium text-zh-ink-2">{issue.ruleId}</span>
        {issue.autoFixable && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium text-green-800 bg-green-50">{t('page.performance.autoFixable')}</span>
        )}
        <CopyToAiButton className="ml-auto" onClick={() => onCopyToAi(issue)} />
      </div>
      <div className="mt-2 text-xs text-zh-muted">
        {issue.file}{issue.line != null ? `:${issue.line}` : ''}
      </div>
      <div className="mt-1 text-xs text-zh-muted">{issue.message}</div>
      {issue.suggestion && (
        <div className="mt-1 text-xs text-blue-500">{t('page.performance.suggestion', { suggestion: issue.suggestion })}</div>
      )}
    </ResultCard>
  );
}

export function IssuesPanel({ issues, onCopyToAi, onCopyAll }: { issues: PerformanceReportData['issues']; onCopyToAi: (issue: PerformanceReportData['issues'][number]) => void; onCopyAll: () => void }) {
  const t = useT();
  return (
    <div>
      {issues.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-zh-muted">{t('page.performance.copyAllHint', { count: issues.length })}</span>
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
            <span className="text-sm font-medium text-green-700">{t('page.performance.noIssues')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
