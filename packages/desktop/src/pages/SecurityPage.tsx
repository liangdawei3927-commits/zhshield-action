import { useEffect, useMemo, useState, useCallback } from 'react';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useSavedDomainReport } from '../hooks/useSavedDomainReport';
import { useHasDomainResult } from '../hooks/useHasDomainResult';
import { useDomainDetailEntry, type DomainSnapshotViewProps } from '../hooks/useDomainDetailEntry';
import { useDetailIntentEffect } from '../hooks/useDetailIntent';
import { useScanResultEntry } from '../hooks/useScanResultEntry';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import { useSecurityPage } from './security-logic';
import { useSecretsPage } from './secrets-logic';
import { SecurityEmptyState } from './security-empty-state';
import { SecretsListCard } from './secrets-parts';
import { ScanEmptyStateBranch } from '../components/business/ScanEmptyState';
import { NavGlyph } from '../components/business/page-glyph';
import type { SecretReportData, SecurityScanReportData } from '../types/electron';
import {
  SecurityReportView,
  renderFindingsPanel,
  renderMalwarePanel,
  type SecurityReportCopyProps,
  type SecuritySecretsProps,
  type SecurityTab,
} from './security-report-parts';

interface SecurityPageProps {
  projectPath: string;
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

function useSecurityPageState(projectPath: string) {
  // 打开先落在主页（与改动前一致）；历史报告只让详情按钮可见，不自动进详情
  const [showHome, setShowHome] = useState(true);
  // 本次跳转带「看结果」意图（扫描进度条点进来）→ 直接展开详情
  useDetailIntentEffect('security', () => setShowHome(false));
  const [tab, setTab] = useState<SecurityTab>('vuln');
  const {
    loading,
    progress,
    statusMessage,
    queued,
    queuePosition,
    cancel,
    stopping,
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

  const handleScan = useCallback(async () => {
    await Promise.all([handleSecurityScan(), handleSecretsScan()]);
  }, [handleSecurityScan, handleSecretsScan]);

  // 评分读磁盘、report 读内存：不同源 → 重启后「有分无按钮」。
  // 安全中心有两个数据源（漏洞扫描 + 密钥扫描），各自落盘、各自读回。
  const savedReport = useSavedDomainReport(projectPath, 'security', report);
  const savedSecretsReport = useSavedDomainReport(projectPath, 'secrets', secretsReport);

  // 实时结果优先；扫描进行中不拿旧报告顶替（保持「扫描中看进度」）
  const detailReport = report ?? (loading ? null : savedReport);
  const detailSecretsReport = secretsReport ?? (loading ? null : savedSecretsReport);

  // 扫完要不要进详情：满分 100 留在主页，不满分（或判断不了）才自动展开详情。
  // 两个数据源（漏洞扫描 / 密钥扫描）任一产出新结果都算一次扫描结束，故拼成一个
  // 「本次结果」对象交给判据：它的引用只在两者变化时改变，正好当"新结果"的信标。
  const scanResult = useMemo(
    () => (report === null && secretsReport === null ? null : { report, secretsReport }),
    [report, secretsReport],
  );
  const { scanVersion } = useScanResultEntry({
    projectPath,
    navId: 'security',
    liveReport: scanResult,
    loading,
    onEnterDetail: () => setShowHome(false),
  });

  // 安全中心的主按钮只跑检查、不换页（扫完停主页还是进详情由上面按分数决定）
  const startScan = handleScan;

  return {
    showHome,
    setShowHome,
    scanVersion,
    tab,
    setTab,
    loading,
    progress,
    statusMessage,
    queued,
    queuePosition,
    report,
    detailReport,
    copyToAi,
    copyAllToAi,
    copyMalwareToAi,
    copyMalwareAllToAi,
    secretsReport,
    detailSecretsReport,
    handleMarkRotating,
    handleVerifyRotated,
    handleDismiss,
    secretsCopyToAi,
    secretsCopyAllToAi,
    handleScan,
    startScan,
    cancel,
    stopping,
  };
}

type SecurityPageState = ReturnType<typeof useSecurityPageState>;
type SecurityTranslate = ReturnType<typeof useT>;

/** 快照视图分支：有历史分但无完整报告时，直接回看上次落盘结果（不替用户重扫） */
function SecuritySnapshotView({
  snapshotViewProps,
}: {
  snapshotViewProps: DomainSnapshotViewProps;
}) {
  return (
    <DomainSnapshotReport
      dimension="security"
      icon={<NavGlyph navId="security" />}
      {...snapshotViewProps}
    />
  );
}

/** SecurityReportView 的入参装配（页面状态 → 视图 props，SecurityPage 只留分支） */
function securityReportViewProps(
  state: SecurityPageState,
  report: NonNullable<SecurityPageState['detailReport']>,
  projectPath: string,
) {
  return {
    projectPath,
    report,
    loading: state.loading,
    progress: state.progress,
    statusMessage: state.statusMessage,
    queued: state.queued,
    onCancel: state.cancel,
    stopping: state.stopping,
    tab: state.tab,
    onTabChange: state.setTab,
    onRescan: state.handleScan,
    onBackHome: () => state.setShowHome(true),
    copyToAi: state.copyToAi,
    copyAllToAi: state.copyAllToAi,
    copyMalwareToAi: state.copyMalwareToAi,
    copyMalwareAllToAi: state.copyMalwareAllToAi,
  };
}

/** 报告正文：当前分类（漏洞 / 恶意代码 / 密钥）的明细面板 */
function securityTabContent(
  state: SecurityPageState,
  report: NonNullable<SecurityPageState['detailReport']>,
  t: SecurityTranslate,
) {
  return (
    <SecurityTabContent
      report={report}
      secretsReport={state.detailSecretsReport}
      tab={state.tab}
      copyToAi={state.copyToAi}
      copyAllToAi={state.copyAllToAi}
      copyMalwareToAi={state.copyMalwareToAi}
      copyMalwareAllToAi={state.copyMalwareAllToAi}
      onMarkRotating={state.handleMarkRotating}
      onVerifyRotated={state.handleVerifyRotated}
      onDismiss={state.handleDismiss}
      secretsCopyToAi={state.secretsCopyToAi}
      secretsCopyAllToAi={state.secretsCopyAllToAi}
      t={t}
    />
  );
}

export function SecurityPage({ projectPath }: SecurityPageProps) {
  const t = useT();
  const state = useSecurityPageState(projectPath);

  // 该域跑过（磁盘有结果 = 页面上有分）→ 详情入口可见；没跑过 → 不显示
  const hadPreviousResult = useHasDomainResult(projectPath, 'security');
  // 单一判定源：实时结果优先，其次落盘读回的历史报告（扫描中不用旧报告顶替）。
  // 此处刻意用解构后的裸名：`domain-reports` 守卫按 `hasDetail = detailReport !== null ||`
  // 逐字断言六个分类页，写成 `state.detailReport` 会让守卫假红。
  const { detailReport } = state;
  const hasDetail = detailReport !== null || hadPreviousResult;

  // 有分但还没有完整报告（本次升级前扫的）：直接展示上次落盘结果，不重扫
  const { showSnapshot, setShowSnapshot, openDetail, snapshotViewProps } = useDomainDetailEntry({
    projectPath,
    domain: 'security',
    detailReport: state.detailReport,
    onEnterDetail: () => state.setShowHome(false),
    rescanning: state.loading,
    onRescan: state.handleScan,
  });

  // 实时扫描出结果时退出快照视图 —— 复刻原有「扫完直接看报告」
  useEffect(() => {
    if (state.detailReport) setShowSnapshot(false);
  }, [state.detailReport]);

  if (showSnapshot) {
    return <SecuritySnapshotView snapshotViewProps={snapshotViewProps} />;
  }

  if (state.detailReport && !state.showHome) {
    return (
      <SecurityReportView
        {...securityReportViewProps(state, state.detailReport, projectPath)}
      >
        {securityTabContent(state, state.detailReport, t)}
      </SecurityReportView>
    );
  }

  return (
    <DetailEntryProvider
      key={state.scanVersion}
      available={hasDetail}
      onOpen={openDetail}
    >
      <ScanEmptyStateBranch
        projectPath={projectPath}
        loading={state.loading}
        progress={state.progress}
        statusMessage={state.statusMessage}
        queued={state.queued}
        queuePosition={state.queuePosition}
        onCancel={state.cancel}
        stopping={state.stopping}
        onScan={state.startScan}
        render={(empty) => <SecurityEmptyState {...empty} />}
      />
    </DetailEntryProvider>
  );
}
