import { useDashboardPage } from './dashboard-logic';
import type { CheckSummary } from './dashboard-logic';
import type { PipelineReportData } from '../types/electron';
import { CheckResultView } from './dashboard-result';
import { HomeView } from './dashboard-parts';
import { useT } from '../i18n';

interface DashboardPageProps {
  projectPath: string;
}

interface ResultViewProps {
  summary: CheckSummary;
  lastReport: PipelineReportData;
  score: number | null;
  autoFixNotice: string | null;
  handleOneClickCheck: () => Promise<void>;
  copyFailedIssues: (items: CheckSummary['failedItems']) => void;
  clearReport: () => void;
}

function renderResultView({
  summary,
  lastReport,
  score,
  autoFixNotice,
  handleOneClickCheck,
  copyFailedIssues,
  clearReport,
}: ResultViewProps) {
  const issueCount = summary.failed + summary.errors;
  const ok = lastReport.passed && issueCount === 0;

  return (
    <CheckResultView
      summary={summary}
      ok={ok}
      score={score}
      autoFixNotice={autoFixNotice}
      onRerun={() => void handleOneClickCheck()}
      onBack={clearReport}
      onCopyIssues={copyFailedIssues}
    />
  );
}

export function DashboardPage({ projectPath }: DashboardPageProps) {
  // 订阅 i18n context：语言切换时重渲染，使逻辑层派生文案（进度/提示）同步更新
  useT();
  const {
    score,
    running,
    progressLabel,
    pipelineProgress,
    autoFixNotice,
    lastReport,
    summary,
    handleOneClickCheck,
    copyFailedIssues,
    clearReport,
  } = useDashboardPage(projectPath);

  if (summary && lastReport && !running) {
    return renderResultView({
      summary,
      lastReport,
      score,
      autoFixNotice,
      handleOneClickCheck,
      copyFailedIssues,
      clearReport,
    });
  }

  return (
    <HomeView
      score={score}
      running={running}
      progressLabel={progressLabel}
      pipelineProgress={pipelineProgress}
      autoFixNotice={autoFixNotice}
      onCheck={() => void handleOneClickCheck()}
    />
  );
}
