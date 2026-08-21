import { useTechDebtPage } from './tech-debt-logic';
import {
  TechDebtEmptyState,
  TechDebtHeader,
  TechDebtOverviewCard,
  TechDebtModuleCard,
  TechDebtCategoryCard,
  TechDebtActionsCard,
  TechDebtCompositionIntroCard,
} from './tech-debt-parts';

interface TechDebtPageProps {
  projectPath: string;
}

export function TechDebtPage({ projectPath }: TechDebtPageProps) {
  const { loading, report, planLoading, verifyLoading, handleScan, handlePlan, handleVerify, handleDismiss, copyToAi, copyAllToAi } = useTechDebtPage(projectPath);

  if (report) {
    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <TechDebtHeader report={report} loading={loading} onRescan={handleScan} />
          <TechDebtOverviewCard report={report} />
          <TechDebtModuleCard modules={report.byModule} />
          <TechDebtCompositionIntroCard />
          <TechDebtCategoryCard categories={report.byCategory} />
          <TechDebtActionsCard
            actions={report.actionList}
            onCopyToAi={copyToAi}
            onCopyAllToAi={copyAllToAi}
            onPlan={handlePlan}
            onVerify={handleVerify}
            onDismiss={handleDismiss}
            planLoading={planLoading}
            verifyLoading={verifyLoading}
          />
        </div>
      </div>
    );
  }

  return <TechDebtEmptyState loading={loading} onScan={handleScan} />;
}
