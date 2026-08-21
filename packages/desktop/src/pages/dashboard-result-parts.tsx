import { CHECK_SCOPE, type CheckSummary } from './dashboard-logic';
import { HealthRing } from './dashboard-parts';
import { ScopeBlock } from './dashboard-panels';
import { Bounce, BounceCard } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import { useT } from '../i18n';

function ResultStats({ summary }: { summary: CheckSummary }) {
  const t = useT();
  const issueCount = summary.failed + summary.errors;

  return (
    <div className="grid grid-cols-4 gap-3 mb-6">
      {[
        { labelKey: 'page.dashboard.result.stats.total', value: summary.total, color: 'rgb(var(--zh-ink))' },
        { labelKey: 'page.dashboard.result.stats.passed', value: summary.passed, color: 'rgb(var(--zh-success))' },
        { labelKey: 'page.dashboard.result.stats.issues', value: issueCount, color: issueCount ? 'rgb(var(--zh-danger))' : 'rgb(var(--zh-success))' },
        { labelKey: 'page.dashboard.result.stats.skipped', value: summary.skipped, color: 'rgb(var(--zh-warning))' },
      ].map((x) => (
        <BounceCard key={x.labelKey} className="rounded-xl bg-zh-panel p-4 text-center">
          <div className="text-2xl font-bold" style={{ color: x.color }}>{x.value}</div>
          <div className="text-xs text-zh-muted mt-1">{t(x.labelKey)}</div>
        </BounceCard>
      ))}
    </div>
  );
}

function ResultHeader({ ok, score, summary, onRerun, onBack }: {
  ok: boolean;
  score: number | null;
  summary: CheckSummary;
  onRerun: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const displayScore = score ?? 0;
  return (
    <div className="flex items-start gap-5 mb-8">
      <HealthRing score={ok ? Math.max(displayScore, 85) : Math.min(displayScore, 70)} />
      <div className="flex-1 pt-4">
        <h1 className="text-2xl font-bold text-zh-ink mb-2">
          {ok ? t('page.dashboard.result.header.passed') : t('page.dashboard.result.header.failed')}
        </h1>
        <p className="text-sm text-zh-muted leading-relaxed">
          {t('page.dashboard.result.header.coverage', { inspectTotal: summary.inspectTotal })}
          {summary.skipped > 0 ? ` ${t('page.dashboard.result.header.skipped', { skipped: summary.skipped })}` : ''}
          {t('page.dashboard.result.header.configureHint')}
        </p>
        <div className="flex gap-3 mt-5">
          <PrimaryButton onClick={onRerun}>{t('page.dashboard.result.rerun')}</PrimaryButton>
          <Bounce
            as="button"
            onClick={onBack}
            className="w-[180px] h-12 rounded-full bg-zh-panel text-zh-ink-2 text-sm font-medium border-none cursor-pointer hover:bg-zh-line transition-colors"
          >
            {t('page.dashboard.result.backHome')}
          </Bounce>
        </div>
      </div>
    </div>
  );
}

function FailedIssuesList({ summary, onCopyIssues }: { summary: CheckSummary; onCopyIssues: (items: CheckSummary['failedItems']) => void }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-red-100 bg-red-50/40 p-5 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-red-700">{t('page.dashboard.result.issuesTitle')}</h3>
        <CopyAllToAiButton onClick={() => onCopyIssues(summary.failedItems)} />
      </div>
      <ul className="space-y-2">
        {summary.failedItems.slice(0, 20).map((item) => (
          <li key={`${item.stage}-${item.id}`} className="text-sm text-zh-ink-2">
            <span className="text-xs text-red-500 mr-2">
              {item.stage === 'guard' ? t('page.dashboard.result.stage.guard') : t('page.dashboard.result.stage.inspect')}
            </span>
            <span className="font-medium">{item.name}</span>
            <span className="text-zh-muted"> — {item.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 本次体检范围面板 */
function ScopeOverview() {
  const t = useT();
  return (
    <ResultCard variant="score" className="mb-6">
      <h3 className="text-sm font-semibold text-zh-ink mb-3">{t('page.dashboard.result.scopeTitle')}</h3>
      <div className="space-y-3">
        {CHECK_SCOPE.map((block) => (
          <ScopeBlock key={block.key} titleKey={block.titleKey} items={block.items} />
        ))}
      </div>
    </ResultCard>
  );
}

/** 自动修复结果提示条 */
function AutoFixNotice({ notice }: { notice: string }) {
  const t = useT();
  return (
    <div className="mb-6 max-w-2xl rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 leading-relaxed">
      <span className="font-semibold mr-1">{t('page.dashboard.autoFix')}</span>
      {notice}
    </div>
  );
}

/** 检查结果区：有问题列表或全部通过提示 */
function IssuesOutcome({ summary, onCopyIssues }: { summary: CheckSummary; onCopyIssues: (items: CheckSummary['failedItems']) => void }) {
  const t = useT();
  if (summary.failedItems.length > 0) {
    return <FailedIssuesList summary={summary} onCopyIssues={onCopyIssues} />;
  }

  return (
    <div className="rounded-xl border border-green-100 bg-green-50/50 p-5 mb-6 text-sm text-green-900">
      {t('page.dashboard.result.allPassed')}
    </div>
  );
}

export { ResultStats, ResultHeader, FailedIssuesList, ScopeOverview, AutoFixNotice, IssuesOutcome };
