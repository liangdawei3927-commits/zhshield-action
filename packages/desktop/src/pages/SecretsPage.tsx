import { useSecretsPage } from './secrets-logic';
import { SecretsEmptyState, SecretsHeader, SecretsListCard } from './secrets-parts';

interface SecretsPageProps {
  projectPath: string;
}

export function SecretsPage({ projectPath }: SecretsPageProps) {
  const { loading, report, handleScan, handleMarkRotating, handleVerifyRotated, handleDismiss } = useSecretsPage(projectPath);

  if (report) {
    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <SecretsHeader report={report} loading={loading} onRescan={handleScan} />
          <SecretsListCard
            findings={report.findings}
            onMarkRotating={handleMarkRotating}
            onVerifyRotated={handleVerifyRotated}
            onDismiss={handleDismiss}
          />
        </div>
      </div>
    );
  }

  return <SecretsEmptyState loading={loading} onScan={handleScan} />;
}
