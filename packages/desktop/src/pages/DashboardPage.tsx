import { useDashboardPage } from './dashboard-logic';
import { CheckResultView } from './dashboard-result';
import { HomeView } from './dashboard-parts';
import { useT } from '../i18n';

interface DashboardPageProps {
  projectPath: string;
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
