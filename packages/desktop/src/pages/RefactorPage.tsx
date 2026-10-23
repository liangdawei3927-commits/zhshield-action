import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useSavedDomainReport } from '../hooks/useSavedDomainReport';
import { useHasDomainResult } from '../hooks/useHasDomainResult';
import { useDomainSnapshot } from '../hooks/useDomainSnapshot';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import { ReportShell } from '../components/business/ReportShell';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { useRefactorPage } from './refactor-logic';
import { RuleTabs } from './refactor-parts';
import { SmellGroupPanel } from './refactor-panel';
import { RefactorEmptyState } from './refactor-empty-state';

interface RefactorPageProps {
  projectPath: string;
}

export function RefactorPage({ projectPath }: RefactorPageProps) {
  const t = useT();
  // 打开先落在主页（与改动前一致）；历史报告只让详情按钮可见，不自动进详情
  const [showHome, setShowHome] = useState(true);
  const {
    scanning,
    progress,
    progressLabel,
    statusMessage,
    report,
    error,
    activeRuleId,
    setActiveRuleId,
    activeGroup,
    groups,
    copyToAi,
    copyGroupToAi,
    handleScan,
  } = useRefactorPage(projectPath);

  // 评分读磁盘、report 读内存：不同源 → 重启后「有分无按钮」。读回上次完整报告（同口径）。
  const savedReport = useSavedDomainReport(projectPath, 'refactor', report);
  // 该域跑过（磁盘有结果 = 页面上有分）→ 详情入口可见；没跑过 → 不显示
  const hadPreviousResult = useHasDomainResult(projectPath, 'refactor');

  // 单一判定源：实时结果优先；扫描进行中不拿旧报告顶替
  const detailReport = report ?? (scanning ? null : savedReport);
  const hasDetail = detailReport !== null || hadPreviousResult;

  // 有分但还没有完整报告（本次升级前扫的）：直接展示上次落盘结果，不重扫
  const snapshot = useDomainSnapshot(projectPath, 'refactor');
  const [showSnapshot, setShowSnapshot] = useState(false);

  const openDetail = () => {
    if (detailReport) {
      setShowHome(false);
      return;
    }
    snapshot.reload();
    setShowSnapshot(true);
  };

  // 实时扫描出结果时进入详情 —— 复刻原有「扫完直接看报告」的行为
  useEffect(() => {
    if (report) {
      setShowHome(false);
      setShowSnapshot(false);
    }
  }, [report]);

  if (showSnapshot) {
    return (
      <DomainSnapshotReport
        projectPath={projectPath}
        dimension="refactor"
        icon={
          <PageGlyph bg="info" stroke="info">
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
          </PageGlyph>
        }
        snapshot={snapshot.snapshot}
        loading={snapshot.loading}
        rescanning={scanning}
        onRescan={() => void handleScan()}
        onBackHome={() => setShowSnapshot(false)}
      />
    );
  }

  if (detailReport && !showHome) {
    return (
      <ReportShell
        projectPath={projectPath}
        dimension="refactor"
        historyDomain="refactor"
        refreshKey={detailReport}
        icon={
          <PageGlyph bg="info" stroke="info">
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
          </PageGlyph>
        }
        title={t('page.refactor.header.title')}
        action={
          <PrimaryButton
            onClick={() => void handleScan()}
            loading={scanning}
            loadingLabel={progressLabel || t('page.refactor.scanning')}
          >
            {t('page.refactor.scanNow')}
          </PrimaryButton>
        }
        onBackHome={() => setShowHome(true)}
        loading={scanning}
        progress={progress}
        progressMessage={statusMessage}
        stats={refactorReportStats(t, detailReport)}
      >
        <RefactorGroupsSection
          t={t}
          report={detailReport}
          error={error}
          groups={groups}
          activeRuleId={activeRuleId}
          setActiveRuleId={setActiveRuleId}
          activeGroup={activeGroup}
          copyGroupToAi={copyGroupToAi}
          copyToAi={copyToAi}
        />
      </ReportShell>
    );
  }

  return (
    <DetailEntryProvider available={hasDetail} onOpen={openDetail}>
      <RefactorEmptyState
        projectPath={projectPath}
        error={error}
        scanning={scanning}
        progress={progress}
        statusMessage={statusMessage}
        onScan={() => {
          setShowHome(false);
          void handleScan();
        }}
      />
    </DetailEntryProvider>
  );
}

type RefactorState = ReturnType<typeof useRefactorPage>;
type RefactorT = ReturnType<typeof useT>;

function refactorReportStats(t: RefactorT, report: NonNullable<RefactorState['report']>) {
  return [
    {
      key: 'smells',
      label: t('page.refactor.stats.smells'),
      value: report.totalSmells,
      color: 'rgb(var(--zh-info))',
    },
    {
      key: 'files',
      label: t('page.refactor.stats.files'),
      value: report.files.length,
      color: 'rgb(var(--zh-warning))',
    },
    {
      key: 'highPriority',
      label: t('page.refactor.stats.highPriority'),
      value: report.summary.needsImmediateAction,
      color: 'rgb(var(--zh-danger))',
    },
  ];
}

interface RefactorGroupsSectionProps {
  t: RefactorT;
  report: NonNullable<RefactorState['report']>;
  error: RefactorState['error'];
  groups: RefactorState['groups'];
  activeRuleId: RefactorState['activeRuleId'];
  setActiveRuleId: RefactorState['setActiveRuleId'];
  activeGroup: RefactorState['activeGroup'];
  copyGroupToAi: RefactorState['copyGroupToAi'];
  copyToAi: RefactorState['copyToAi'];
}

function RefactorGroupsSection({
  t,
  report,
  error,
  groups,
  activeRuleId,
  setActiveRuleId,
  activeGroup,
  copyGroupToAi,
  copyToAi,
}: RefactorGroupsSectionProps) {
  return (
    <>
      {error ? <p className="text-sm text-danger-500 mb-4">{error}</p> : null}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zh-ink-2">
            {t('page.refactor.groupedIssues')}
          </h3>
          <span className="text-xs text-zh-muted">
            {t('page.refactor.groupsSummary', {
              groups: groups.length,
              total: report.totalSmells,
            })}
          </span>
        </div>
        {groups.length === 0 ? (
          <ResultCard variant="list" className="p-8 text-center">
            <p className="text-sm text-zh-muted">{t('page.refactor.noSmells')}</p>
          </ResultCard>
        ) : (
          <>
            <RuleTabs groups={groups} activeRuleId={activeRuleId} onSelect={setActiveRuleId} />
            {activeGroup && (
              <SmellGroupPanel
                key={activeGroup.ruleId}
                group={activeGroup}
                onCopyGroup={() => copyGroupToAi(activeGroup!)}
                onCopyItem={(smell) => copyToAi(smell.location.filePath, smell)}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
