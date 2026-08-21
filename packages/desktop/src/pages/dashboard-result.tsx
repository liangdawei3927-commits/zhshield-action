import type { CheckSummary } from './dashboard-logic';
import { AutoFixNotice, IssuesOutcome, ResultHeader, ResultStats, ScopeOverview } from './dashboard-result-parts';

/** 结果正文：评分/统计/范围/提示/问题列表 分区块展示 */
function CheckResultBody({ summary, ok, score, autoFixNotice, onRerun, onBack, onCopyIssues }: {
  summary: CheckSummary;
  ok: boolean;
  score: number | null;
  autoFixNotice: string | null;
  onRerun: () => void;
  onBack: () => void;
  onCopyIssues: (items: CheckSummary['failedItems']) => void;
}) {
  return (
    <div className="w-full px-8 py-10">
      <ResultStatsSection summary={summary} ok={ok} score={score} autoFixNotice={autoFixNotice} onRerun={onRerun} onBack={onBack} />

      <IssuesSection summary={summary} onCopyIssues={onCopyIssues} />
    </div>
  );
}

function ResultStatsSection({ summary, ok, score, autoFixNotice, onRerun, onBack }: {
  summary: CheckSummary;
  ok: boolean;
  score: number | null;
  autoFixNotice: string | null;
  onRerun: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <ResultHeader ok={ok} score={score} summary={summary} onRerun={onRerun} onBack={onBack} />

      <ResultStats summary={summary} />

      <ScopeOverview />

      {autoFixNotice ? <AutoFixNotice notice={autoFixNotice} /> : null}
    </>
  );
}

function IssuesSection({ summary, onCopyIssues }: {
  summary: CheckSummary;
  onCopyIssues: (items: CheckSummary['failedItems']) => void;
}) {
  return (
    <>
      <IssuesOutcome summary={summary} onCopyIssues={onCopyIssues} />
    </>
  );
}

export function CheckResultView({ summary, ok, score, autoFixNotice, onRerun, onBack, onCopyIssues }: {
  summary: CheckSummary;
  ok: boolean;
  score: number | null;
  autoFixNotice: string | null;
  onRerun: () => void;
  onBack: () => void;
  onCopyIssues: (items: CheckSummary['failedItems']) => void;
}) {
  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <CheckResultBody
        summary={summary}
        ok={ok}
        score={score}
        autoFixNotice={autoFixNotice}
        onRerun={onRerun}
        onBack={onBack}
        onCopyIssues={onCopyIssues}
      />
    </div>
  );
}
