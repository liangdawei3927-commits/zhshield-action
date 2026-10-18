import { useState, useCallback } from 'react';
import { useT } from '../i18n';
import { useSecurityPage } from './security-logic';
import { useSecretsPage } from './secrets-logic';
import { SecurityEmptyState } from './security-empty-state';
import { FindingsPanel, MalwarePanel } from './security-parts';
import { SecretsListCard } from './secrets-parts';
import { ReportShell } from '../components/business/ReportShell';
import type { ReportStatCard } from '../components/business/ReportShell';
import { ScanEmptyStateBranch } from '../components/business/ScanEmptyState';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import type { SecurityIssue } from './security-logic';
import type { SecurityScanReportData, SecretReportData } from '../types/electron';

interface SecurityPageProps {
  projectPath: string;
}

type SecurityTab = 'vuln' | 'malware' | 'secrets';

type Translate = (key: string, params?: Record<string, unknown>) => string;

const TABS: Array<{ id: SecurityTab; labelKey: string }> = [
  { id: 'vuln', labelKey: 'page.security.tab.vuln' },
  { id: 'malware', labelKey: 'page.security.tab.malware' },
  { id: 'secrets', labelKey: 'page.security.tab.secrets' },
];

const SEVERITY_KEYS = ['critical', 'high', 'medium', 'low'] as const;

interface SecurityReportCopyProps {
  copyToAi: (issue: SecurityIssue) => void;
  copyAllToAi: (issues: SecurityIssue[]) => void;
  copyMalwareToAi: (item: SecurityScanReportData['malware'][number]) => void;
  copyMalwareAllToAi: (items: SecurityScanReportData['malware']) => void;
}

interface SecuritySecretsProps {
  onMarkRotating: (secretId: string) => void;
  onVerifyRotated: (secretId: string) => void;
  onDismiss: (secretId: string) => void;
  secretsCopyToAi: (finding: SecretReportData['findings'][number]) => void;
  secretsCopyAllToAi: (findings: SecretReportData['findings']) => void;
  t: Translate;
}

function renderFindingsPanel(
  items: SecurityScanReportData['findings'],
  onCopyToAi: (issue: SecurityIssue) => void,
  onCopyAll: (issues: SecurityIssue[]) => void,
) {
  return <FindingsPanel findings={items} onCopyToAi={onCopyToAi} onCopyAll={onCopyAll} />;
}

function renderMalwarePanel(
  items: SecurityScanReportData['malware'],
  onCopyToAi: (item: SecurityScanReportData['malware'][number]) => void,
  onCopyAll: (items: SecurityScanReportData['malware']) => void,
) {
  return <MalwarePanel items={items} onCopyToAi={onCopyToAi} onCopyAll={onCopyAll} />;
}

/** 报告统计卡：总数 + 各严重级别 + 恶意代码，明细复用 FindingsPanel/MalwarePanel */
function buildSecurityStats({
  report,
  copyToAi,
  copyAllToAi,
  copyMalwareToAi,
  copyMalwareAllToAi,
  t,
}: {
  report: SecurityScanReportData;
  t: Translate;
} & SecurityReportCopyProps): ReportStatCard[] {
  return [
    { key: 'total', label: t('page.security.stats.total'), value: report.summary.total },
    ...SEVERITY_KEYS.map((sev) => {
      const items = report.findings.filter((f) => f.severity === sev);
      return {
        key: sev,
        label: t(`severity.${sev}`),
        value: report.summary[sev],
        detail: {
          items,
          render: (sub: unknown[]) =>
            renderFindingsPanel(sub as SecurityScanReportData['findings'], copyToAi, copyAllToAi),
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
        render: (sub: unknown[]) =>
          renderMalwarePanel(sub as SecurityScanReportData['malware'], copyMalwareToAi, copyMalwareAllToAi),
      },
    },
  ];
}

/** 分类切换标签栏 */
function SecurityTabBar({
  tab,
  onTabChange,
  t,
}: {
  tab: SecurityTab;
  onTabChange: (tab: SecurityTab) => void;
  t: Translate;
}) {
  return (
    <div className="flex gap-2 mb-6">
      {TABS.map((t2) => (
        <button
          key={t2.id}
          onClick={() => onTabChange(t2.id)}
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
  );
}

interface SecurityTabContentProps extends SecurityReportCopyProps, SecuritySecretsProps {
  report: SecurityScanReportData;
  secretsReport: SecretReportData | null;
  tab: SecurityTab;
}

/** 当前分类的明细面板（漏洞 / 恶意代码 / 密钥） */
function SecurityTabContent({
  report,
  secretsReport,
  tab,
  copyToAi,
  copyAllToAi,
  copyMalwareToAi,
  copyMalwareAllToAi,
  onMarkRotating,
  onVerifyRotated,
  onDismiss,
  secretsCopyToAi,
  secretsCopyAllToAi,
  t,
}: SecurityTabContentProps) {
  if (tab === 'vuln') {
    return renderFindingsPanel(report.findings, copyToAi, copyAllToAi);
  }
  if (tab === 'malware') {
    return renderMalwarePanel(report.malware, copyMalwareToAi, copyMalwareAllToAi);
  }
  if (secretsReport) {
    return (
      <SecretsListCard
        findings={secretsReport.findings}
        error={secretsReport.error}
        onMarkRotating={onMarkRotating}
        onVerifyRotated={onVerifyRotated}
        onDismiss={onDismiss}
        onCopyToAi={secretsCopyToAi}
        onCopyAll={secretsCopyAllToAi}
      />
    );
  }
  return (
    <div className="rounded-xl flex flex-col items-center justify-center py-12 gap-2 bg-zh-panel border border-dashed border-zh-line">
      <span className="text-sm text-zh-muted">{t('page.secrets.checking')}</span>
    </div>
  );
}

interface SecurityReportViewProps extends SecurityReportCopyProps, SecuritySecretsProps {
  projectPath: string;
  report: SecurityScanReportData;
  secretsReport: SecretReportData | null;
  loading: boolean;
  progressLabel: string;
  tab: SecurityTab;
  onTabChange: (tab: SecurityTab) => void;
  onRescan: () => void;
  onBackHome: () => void;
}

/** 报告态：统计卡 + 分类标签栏 + 明细面板 */
function SecurityReportView({
  projectPath,
  report,
  secretsReport,
  loading,
  progressLabel,
  tab,
  onTabChange,
  onRescan,
  onBackHome,
  copyToAi,
  copyAllToAi,
  copyMalwareToAi,
  copyMalwareAllToAi,
  onMarkRotating,
  onVerifyRotated,
  onDismiss,
  secretsCopyToAi,
  secretsCopyAllToAi,
  t,
}: SecurityReportViewProps) {
  return (
    <ReportShell
      projectPath={projectPath}
      dimension="security"
      refreshKey={report}
      icon={
        <PageGlyph bg="danger" stroke="danger">
          <path d="M12 2L3 7v6c0 5.25 3.83 10.13 9 11.25C17.17 23.13 21 18.25 21 13V7l-9-5z" />
          <path d="M9 13l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </PageGlyph>
      }
      title={t('page.security.done')}
      action={
        <PrimaryButton
          onClick={onRescan}
          loading={loading}
          loadingLabel={progressLabel || t('page.security.checking')}
        >
          {t('page.security.rescan')}
        </PrimaryButton>
      }
      onBackHome={onBackHome}
      stats={buildSecurityStats({
        report,
        copyToAi,
        copyAllToAi,
        copyMalwareToAi,
        copyMalwareAllToAi,
        t,
      })}
    >
      <SecurityTabBar tab={tab} onTabChange={onTabChange} t={t} />
      <SecurityTabContent
        report={report}
        secretsReport={secretsReport}
        tab={tab}
        copyToAi={copyToAi}
        copyAllToAi={copyAllToAi}
        copyMalwareToAi={copyMalwareToAi}
        copyMalwareAllToAi={copyMalwareAllToAi}
        onMarkRotating={onMarkRotating}
        onVerifyRotated={onVerifyRotated}
        onDismiss={onDismiss}
        secretsCopyToAi={secretsCopyToAi}
        secretsCopyAllToAi={secretsCopyAllToAi}
        t={t}
      />
    </ReportShell>
  );
}

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
      <SecurityReportView
        projectPath={projectPath}
        report={report}
        secretsReport={secretsReport}
        loading={loading}
        progressLabel={progressLabel}
        tab={tab}
        onTabChange={setTab}
        onRescan={handleScan}
        onBackHome={() => setShowHome(true)}
        copyToAi={copyToAi}
        copyAllToAi={copyAllToAi}
        copyMalwareToAi={copyMalwareToAi}
        copyMalwareAllToAi={copyMalwareAllToAi}
        onMarkRotating={handleMarkRotating}
        onVerifyRotated={handleVerifyRotated}
        onDismiss={handleDismiss}
        secretsCopyToAi={secretsCopyToAi}
        secretsCopyAllToAi={secretsCopyAllToAi}
        t={t}
      />
    );
  }

  return (
    <ScanEmptyStateBranch
      {...emptyStateParams}
      render={(empty) => <SecurityEmptyState {...empty} />}
    />
  );
}
