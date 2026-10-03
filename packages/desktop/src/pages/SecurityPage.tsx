import { useState, useCallback } from 'react';
import { useT } from '../i18n';
import { useSecurityPage } from './security-logic';
import { useSecretsPage } from './secrets-logic';
import { SecurityEmptyState } from './security-empty-state';
import { FindingsPanel, MalwarePanel } from './security-parts';
import { SecretsListCard } from './secrets-parts';
import { ReportShell } from '../components/business/ReportShell';
import { ScanEmptyStateBranch } from '../components/business/ScanEmptyState';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import type { SecurityScanReportData } from '../types/electron';

interface SecurityPageProps {
  projectPath: string;
}

type SecurityTab = 'vuln' | 'malware' | 'secrets';

const TABS: Array<{ id: SecurityTab; labelKey: string }> = [
  { id: 'vuln', labelKey: 'page.security.tab.vuln' },
  { id: 'malware', labelKey: 'page.security.tab.malware' },
  { id: 'secrets', labelKey: 'page.security.tab.secrets' },
];

const SEVERITY_KEYS = ['critical', 'high', 'medium', 'low'] as const;

export function SecurityPage({ projectPath }: SecurityPageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(false);
  const {
    loading,
    progress,
    progressLabel,
    statusMessage,
    report,
    copyToAi,
    copyAllToAi,
    copyMalwareToAi,
    copyMalwareAllToAi,
    handleScan: handleSecurityScan,
  } = useSecurityPage(projectPath);
  const {
    report: secretsReport,
    handleScan: handleSecretsScan,
    handleMarkRotating,
    handleVerifyRotated,
    handleDismiss,
    copyToAi: secretsCopyToAi,
    copyAllToAi: secretsCopyAllToAi,
  } = useSecretsPage(projectPath);
  const [tab, setTab] = useState<SecurityTab>('vuln');

  const handleScan = useCallback(async () => {
    await Promise.all([handleSecurityScan(), handleSecretsScan()]);
  }, [handleSecurityScan, handleSecretsScan]);

  const startScan = () => {
    setShowHome(false);
    handleScan();
  };
  const emptyStateParams = {
    projectPath,
    loading,
    progress,
    statusMessage,
    onScan: startScan,
  };

  if (report && !showHome) {
    return (
      <ReportShell
        projectPath={projectPath}
        dimension="security"
        refreshKey={report}
        icon={
          <Bounce className="w-14 h-14 rounded-xl bg-danger-50 flex items-center justify-center">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="rgb(var(--zh-danger))"
              strokeWidth="2"
            >
              <path d="M12 2L3 7v6c0 5.25 3.83 10.13 9 11.25C17.17 23.13 21 18.25 21 13V7l-9-5z" />
              <path d="M9 13l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Bounce>
        }
        title={t('page.security.done')}
        action={
          <PrimaryButton
            onClick={handleScan}
            loading={loading}
            loadingLabel={progressLabel || t('page.security.checking')}
          >
            {t('page.security.rescan')}
          </PrimaryButton>
        }
        onBackHome={() => setShowHome(true)}
        stats={[
          { key: 'total', label: t('page.security.stats.total'), value: report.summary.total },
          ...SEVERITY_KEYS.map((sev) => {
            const items = report.findings.filter((f) => f.severity === sev);
            return {
              key: sev,
              label: t(`severity.${sev}`),
              value: report.summary[sev],
              detail: {
                items,
                render: (sub: unknown[]) => (
                  <FindingsPanel
                    findings={sub as SecurityScanReportData['findings']}
                    onCopyToAi={copyToAi}
                    onCopyAll={copyAllToAi}
                  />
                ),
                hint: t('page.security.copyAllPrompt', { count: items.length }),
              },
            };
          }),
          {
            key: 'malware',
            label: t('page.security.stats.malware'),
            value: report.summary.malwareTotal,
            detail: {
              items: report.malware,
              render: (sub) => (
                <MalwarePanel
                  items={sub as SecurityScanReportData['malware']}
                  onCopyToAi={copyMalwareToAi}
                  onCopyAll={copyMalwareAllToAi}
                />
              ),
            },
          },
        ]}
      >
        <div className="flex gap-2 mb-6">
          {TABS.map((t2) => (
            <button
              key={t2.id}
              onClick={() => setTab(t2.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium border-none cursor-pointer transition-colors ${
                tab === t2.id
                  ? 'bg-danger-600 text-white'
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
          <MalwarePanel
            items={report.malware}
            onCopyToAi={copyMalwareToAi}
            onCopyAll={copyMalwareAllToAi}
          />
        ) : secretsReport ? (
          <SecretsListCard
            findings={secretsReport.findings}
            error={secretsReport.error}
            onMarkRotating={handleMarkRotating}
            onVerifyRotated={handleVerifyRotated}
            onDismiss={handleDismiss}
            onCopyToAi={secretsCopyToAi}
            onCopyAll={secretsCopyAllToAi}
          />
        ) : (
          <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
            <span className="text-sm text-zh-muted">{t('page.secrets.checking')}</span>
          </div>
        )}
      </ReportShell>
    );
  }

  return (
    <ScanEmptyStateBranch
      {...emptyStateParams}
      render={(empty) => <SecurityEmptyState {...empty} />}
    />
  );
}