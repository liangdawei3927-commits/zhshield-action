import { useState, useCallback } from 'react';
import { useT } from '../i18n';
import { useSecurityPage } from './security-logic';
import { useSecretsPage } from './secrets-logic';
import { SecurityEmptyState } from './security-empty-state';
import { SecurityHeader, SecurityScoreCard, FindingsPanel, MalwarePanel } from './security-parts';
import { SecretsListCard } from './secrets-parts';

interface SecurityPageProps {
  projectPath: string;
}

type SecurityTab = 'vuln' | 'malware' | 'secrets';

const TABS: Array<{ id: SecurityTab; labelKey: string }> = [
  { id: 'vuln', labelKey: 'page.security.tab.vuln' },
  { id: 'malware', labelKey: 'page.security.tab.malware' },
  { id: 'secrets', labelKey: 'page.security.tab.secrets' },
];

export function SecurityPage({ projectPath }: SecurityPageProps) {
  const t = useT();
  const {
    loading,
    progressLabel,
    report,
    copyToAi,
    copyAllToAi,
    handleScan: handleSecurityScan,
  } = useSecurityPage(projectPath);
  const {
    report: secretsReport,
    handleScan: handleSecretsScan,
    handleMarkRotating,
    handleVerifyRotated,
    handleDismiss,
  } = useSecretsPage(projectPath);
  const [tab, setTab] = useState<SecurityTab>('vuln');

  const handleScan = useCallback(async () => {
    await Promise.all([handleSecurityScan(), handleSecretsScan()]);
  }, [handleSecurityScan, handleSecretsScan]);

  if (report) {
    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <SecurityHeader
            report={report}
            loading={loading}
            progressLabel={progressLabel}
            onRescan={handleScan}
          />
          <SecurityScoreCard report={report} />
          <div className="flex gap-2 mb-6">
            {TABS.map((t2) => (
              <button
                key={t2.id}
                onClick={() => setTab(t2.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border-none cursor-pointer transition-colors ${
                  tab === t2.id
                    ? 'bg-red-600 text-white'
                    : 'bg-zh-panel text-zh-ink-2 hover:bg-zh-line'
                }`}
              >
                {t(t2.labelKey)}
              </button>
            ))}
          </div>
          {tab === 'vuln' ? (
            <FindingsPanel
              findings={report.findings}
              onCopyToAi={copyToAi}
              onCopyAll={copyAllToAi}
            />
          ) : tab === 'malware' ? (
            <MalwarePanel items={report.malware} onCopyToAi={copyToAi} onCopyAll={copyAllToAi} />
          ) : secretsReport ? (
            <SecretsListCard
              findings={secretsReport.findings}
              onMarkRotating={handleMarkRotating}
              onVerifyRotated={handleVerifyRotated}
              onDismiss={handleDismiss}
            />
          ) : (
            <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
              <span className="text-sm text-zh-muted">{t('page.secrets.checking')}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return <SecurityEmptyState loading={loading} progressLabel={progressLabel} onScan={handleScan} />;
}
