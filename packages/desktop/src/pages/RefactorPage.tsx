import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useSavedDomainReport } from '../hooks/useSavedDomainReport';
import { useHasDomainResult } from '../hooks/useHasDomainResult';
import { useDomainDetailEntry } from '../hooks/useDomainDetailEntry';
import { useDetailIntentEffect } from '../hooks/useDetailIntent';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import { ReportShell } from '../components/business/ReportShell';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { useRefactorPage, useSmellGroups } from './refactor-logic';
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
  // 本次跳转带「看结果」意图（扫描进度条点进来）→ 直接展开详情
  useDetailIntentEffect('refactor', () => setShowHome(false));
  const {
    scanning,
    progress,
    progressLabel,
    statusMessage,
    report,
    error,
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

  // 分类聚合必须从「真正要渲染的那份报告」派生。
  // 绑在内存 report 上会出现：重开页面 → 完整报告已从磁盘读回，
  // 但 groups 仍按 null 算 ⇒ 分类 tab 全没了，只剩「暂无重构异味」。
  const { activeRuleId, setActiveRuleId, groups, activeGroup } = useSmellGroups(detailReport);

  const hasDetail = detailReport !== null || hadPreviousResult;

  // 有分但还没有完整报告（本次升级前扫的）：直接展示上次落盘结果，不重扫
  const { showSnapshot, setShowSnapshot, openDetail, snapshotViewProps } = useDomainDetailEntry({
    projectPath,
    domain: 'refactor',
    detailReport,
    onEnterDetail: () => setShowHome(false),
    rescanning: scanning,
    onRescan: () => void handleScan(),
  });

  // 实时扫描出结果时进入详情 —— 复刻原有「扫完直接看报告」的行为。
  // 注：「落盘报告读回后退出快照」不在这里做，已下移到 useDomainDetailEntry
  // （那处是派生判定，六个域页面共用一份，避免各页各写一条 effect 还漏写）。
  useEffect(() => {
    if (report) {
      setShowHome(false);
      setShowSnapshot(false);
    }
  }, [report]);

  if (showSnapshot) {
    return (
      <DomainSnapshotReport
        dimension="refactor"
        icon={
          <PageGlyph bg="info" stroke="info">
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
          </PageGlyph>
        }
        {...snapshotViewProps}
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
/** 分类聚合的状态（来自 useSmellGroups，入参是 detailReport 而非内存 report） */
type SmellGroupsState = ReturnType<typeof useSmellGroups>;
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
  groups: SmellGroupsState['groups'];
  activeRuleId: SmellGroupsState['activeRuleId'];
  setActiveRuleId: SmellGroupsState['setActiveRuleId'];
  activeGroup: SmellGroupsState['activeGroup'];
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
