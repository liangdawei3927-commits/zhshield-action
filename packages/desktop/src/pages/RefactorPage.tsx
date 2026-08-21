import { useRefactorPage } from './refactor-logic';
import { RefactorReportView } from './refactor-parts';
import { RefactorEmptyState } from './refactor-empty-state';

interface RefactorPageProps {
  projectPath: string;
}

export function RefactorPage({ projectPath }: RefactorPageProps) {
  const {
    scanning,
    progressLabel,
    report,
    error,
    lastAutoAt,
    activeRuleId,
    setActiveRuleId,
    activeGroup,
    groups,
    copyToAi,
    copyGroupToAi,
    handleScan,
  } = useRefactorPage(projectPath);

  if (report) {
    return (
      <RefactorReportView
        report={report}
        scanning={scanning}
        progressLabel={progressLabel}
        lastAutoAt={lastAutoAt}
        error={error}
        groups={groups}
        activeRuleId={activeRuleId}
        activeGroup={activeGroup}
        onScan={() => void handleScan()}
        onSelectRule={setActiveRuleId}
        onCopyGroup={() => copyGroupToAi(activeGroup!)}
        onCopyItem={(smell) => copyToAi(smell.location.filePath, smell)}
      />
    );
  }

  return (
    <RefactorEmptyState
      error={error}
      scanning={scanning}
      progressLabel={progressLabel}
      onScan={() => void handleScan()}
    />
  );
}
