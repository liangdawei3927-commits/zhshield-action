import { useState } from 'react';
import { useT } from '../i18n';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useSavedDomainReport } from '../hooks/useSavedDomainReport';
import { useHasDomainResult } from '../hooks/useHasDomainResult';
import { useDomainDetailEntry } from '../hooks/useDomainDetailEntry';
import { useScanResultEntry } from '../hooks/useScanResultEntry';
import { useDetailIntentEffect } from '../hooks/useDetailIntent';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { NavGlyph } from '../components/business/page-glyph';
import { DomainActionButton } from '../components/business/DomainActionButton';
import { ResultCard } from '../components/ui/ResultCard';
import { useRefactorPage, useSmellGroups, type RefactorFile, type Smell } from './refactor-logic';
import { RuleTabs } from './refactor-parts';
import { RefactorFileDetailList, SmellDetailList, SmellGroupPanel } from './refactor-panel';
import { RefactorEmptyState } from './refactor-empty-state';

interface RefactorPageProps {
  projectPath: string;
}

/**
 * 重构域图标：三处（主页 / 详情 / 快照）共用 —— 且**与顶部导航栏同图**。
 *
 * 原实现是内联的「扳手」path，而导航栏「代码重构」画的是双向箭头，同一个分类两套图。
 * 现统一走 `NavGlyph navId="refactor"`，图形只存在于 NAV_ICON_CONTENT。
 */
function RefactorGlyph() {
  return <NavGlyph navId="refactor" />;
}

/**
 * 详情入口状态：读回落盘报告 + 分类聚合 + 快照通道。
 *
 * 与四个域页面共用的 `useDomainDetailPage` 同类，差别只在重构页还要一份
 * 按 `detailReport` 派生的分类聚合（`useSmellGroups`），因此不能直接复用那条
 * 位置式入口，单独收一层。
 */
function useRefactorDetailState(
  projectPath: string,
  page: RefactorState,
  showHome: boolean,
  setShowHome: (next: boolean) => void,
) {
  // 评分读磁盘、report 读内存：不同源 → 重启后「有分无按钮」。读回上次完整报告（同口径）。
  const savedReport = useSavedDomainReport(projectPath, 'refactor', page.report);
  // 该域跑过（磁盘有结果 = 页面上有分）→ 详情入口可见；没跑过 → 不显示
  const hadPreviousResult = useHasDomainResult(projectPath, 'refactor');

  // 单一判定源：实时结果优先；扫描进行中不拿旧报告顶替
  const detailReport = page.report ?? (page.scanning ? null : savedReport);

  // 分类聚合必须从「真正要渲染的那份报告」派生。
  // 绑在内存 report 上会出现：重开页面 → 完整报告已从磁盘读回，
  // 但 groups 仍按 null 算 ⇒ 分类 tab 全没了，只剩「暂无重构异味」。
  const smellGroups = useSmellGroups(detailReport);

  const hasDetail = detailReport !== null || hadPreviousResult;

  // 有分但还没有完整报告（本次升级前扫的）：直接展示上次落盘结果，不重扫
  const entry = useDomainDetailEntry({
    projectPath,
    domain: 'refactor',
    detailReport,
    onEnterDetail: () => setShowHome(false),
    rescanning: page.scanning,
    onRescan: () => void page.handleScan(),
  });

  // 注：「扫完是否进详情」不在这里判 —— 已收敛到页面级的 useScanResultEntry
  // （满分 100 留主页、不满分才展开），避免各页各写一条 effect 还写错口径。

  return { showHome, detailReport, hasDetail, smellGroups, entry };
}

type RefactorState = ReturnType<typeof useRefactorPage>;
/** 分类聚合的状态（来自 useSmellGroups，入参是 detailReport 而非内存 report） */
type SmellGroupsState = ReturnType<typeof useSmellGroups>;
type RefactorT = ReturnType<typeof useT>;

/**
 * 异味分组面板的数据/动作契约：报告壳（RefactorReportView）与分组面板
 * （RefactorGroupsSection）走同一组 props，抽成共享接口避免两处字段清单漂移。
 */
interface SmellGroupsViewProps {
  report: NonNullable<RefactorState['report']>;
  error: RefactorState['error'];
  groups: SmellGroupsState['groups'];
  activeRuleId: SmellGroupsState['activeRuleId'];
  setActiveRuleId: SmellGroupsState['setActiveRuleId'];
  activeGroup: SmellGroupsState['activeGroup'];
  copyGroupToAi: RefactorState['copyGroupToAi'];
  copyToAi: RefactorState['copyToAi'];
}

interface RefactorReportViewProps extends SmellGroupsViewProps {
  projectPath: string;
  t: RefactorT;
  scanning: boolean;
  progress: number;
  statusMessage: string;
  /** 排队中：按钮显示「排队中…」而不是「重构扫描中…」 */
  queued?: boolean;
  /** 停止本次重构扫描（运行/排队时按钮旁出现「停止」） */
  onCancel: () => void;
  /** 已发出取消、等确认 */
  stopping: boolean;
  onRescan: () => void;
  onBackHome: () => void;
}

/** 报告态：报告壳（评分/进度/统计）+ 按规则分类的异味面板 */
function RefactorReportView({
  projectPath,
  t,
  report,
  scanning,
  progress,
  statusMessage,
  queued,
  onCancel,
  stopping,
  onRescan,
  onBackHome,
  error,
  groups,
  activeRuleId,
  setActiveRuleId,
  activeGroup,
  copyGroupToAi,
  copyToAi,
}: RefactorReportViewProps) {
  return (
    <ReportShell
      projectPath={projectPath}
      dimension="refactor"
      historyDomain="refactor"
      refreshKey={report}
      icon={<RefactorGlyph />}
      title={t('page.refactor.header.title')}
      action={
        <DomainActionButton
          domain="refactor"
          onCancel={onCancel}
          stopping={stopping}
          queued={queued}
          onClick={onRescan}
          loading={scanning}
          label={t('page.refactor.scanNow')}
        />
      }
      onBackHome={onBackHome}
      loading={scanning}
      progress={progress}
      progressMessage={statusMessage}
      stats={refactorReportStats(t, report, copyToAi)}
    >
      <RefactorGroupsSection
        t={t}
        report={report}
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

export function RefactorPage({ projectPath }: RefactorPageProps) {
  const t = useT();
  // 打开先落在主页（与改动前一致）；历史报告只让详情按钮可见，不自动进详情
  const [showHome, setShowHome] = useState(true);
  // 本次跳转带「看结果」意图（扫描进度条点进来）→ 直接展开详情
  useDetailIntentEffect('refactor', () => setShowHome(false));
  const page = useRefactorPage(projectPath);
  const detail = useRefactorDetailState(projectPath, page, showHome, setShowHome);
  const { snapshotViewProps, openDetail } = detail.entry;

  // 扫完要不要进详情：只在「本次重构扫描产出新结果」时判，且满分 100 不进（唯一口径）
  const { scanVersion } = useScanResultEntry({
    projectPath,
    navId: 'refactor',
    liveReport: page.report,
    loading: page.scanning,
    onEnterDetail: () => setShowHome(false),
  });

  if (detail.entry.showSnapshot) {
    return (
      <DomainSnapshotReport
        dimension="refactor"
        icon={<RefactorGlyph />}
        {...snapshotViewProps}
      />
    );
  }

  if (detail.detailReport && !detail.showHome) {
    return (
      <RefactorReportView
        projectPath={projectPath}
        t={t}
        report={detail.detailReport}
        scanning={page.scanning}
        progress={page.progress}
        statusMessage={page.statusMessage}
        queued={page.queued}
        onCancel={page.cancel}
        stopping={page.stopping}
        onRescan={() => void page.handleScan()}
        onBackHome={() => setShowHome(true)}
        error={page.error}
        groups={detail.smellGroups.groups}
        activeRuleId={detail.smellGroups.activeRuleId}
        setActiveRuleId={detail.smellGroups.setActiveRuleId}
        activeGroup={detail.smellGroups.activeGroup}
        copyGroupToAi={page.copyGroupToAi}
        copyToAi={page.copyToAi}
      />
    );
  }

  return (
    <DetailEntryProvider key={scanVersion} available={detail.hasDetail} onOpen={openDetail}>
      <RefactorEmptyState
        projectPath={projectPath}
        error={page.error}
        scanning={page.scanning}
        progress={page.progress}
        statusMessage={page.statusMessage}
        queued={page.queued}
        queuePosition={page.queuePosition}
        onCancel={page.cancel}
        stopping={page.stopping}
        onScan={() => void page.handleScan()}
      />
    </DetailEntryProvider>
  );
}

/**
 * 重构页三张统计卡的构造（代码异味 / 需重构文件 / 高优先级）。
 *
 * 三张卡**都必须带 `detail`**：`ReportShell` 的统计卡是否可点击完全由
 * `Boolean(stat.detail)` 决定，缺 detail 会被渲染成不可点的 div —— 视觉上仍是
 * 卡片、`cursor-pointer` 还在，但点下去毫无反应（本函数曾是唯一这么漏的域）。
 * 口径约束：「高优先级」的数字来自引擎 `summary.needsImmediateAction`（文件级
 * critical/high），明细必须用同一份过滤条件，否则点开条数与卡上数字对不上。
 */
export function refactorReportStats(
  t: RefactorT,
  report: NonNullable<RefactorState['report']>,
  copyToAi: RefactorState['copyToAi'],
): ReportStatCard[] {
  const files = report.files;
  // 「高优先级」数字来自引擎 summary.needsImmediateAction，口径是**文件级**
  // critical/high（见 @zh/refactor engine.ts），明细必须同源，否则点开数字对不上。
  const urgentFiles = files.filter(
    (f) => f.refactorPriority === 'critical' || f.refactorPriority === 'high',
  );
  const allSmells = files.flatMap((f) => f.smells);
  return [
    {
      key: 'smells',
      label: t('page.refactor.stats.smells'),
      value: report.totalSmells,
      color: 'rgb(var(--zh-info))',
      detail: {
        items: allSmells,
        hint: t('page.refactor.stats.smellsHint', { defaultValue: '全部代码异味清单（按文件汇总）' }),
        render: (items) => (
          <SmellDetailList
            items={items as Smell[]}
            onCopyItem={(smell) => copyToAi(smell.location.filePath, smell)}
          />
        ),
      },
    },
    {
      key: 'files',
      label: t('page.refactor.stats.files'),
      value: files.length,
      color: 'rgb(var(--zh-warning))',
      detail: {
        items: files,
        hint: t('page.refactor.stats.filesHint', {
          defaultValue: '存在代码异味的文件，含异味处数与可维护性评分',
        }),
        render: (items) => <RefactorFileDetailList files={items as RefactorFile[]} />,
      },
    },
    {
      key: 'highPriority',
      label: t('page.refactor.stats.highPriority'),
      value: report.summary.needsImmediateAction,
      color: 'rgb(var(--zh-danger))',
      detail: {
        items: urgentFiles,
        hint: t('page.refactor.stats.highPriorityHint', {
          defaultValue: '文件级优先级为「紧急 / 高」的文件，建议优先处理',
        }),
        render: (items) => <RefactorFileDetailList files={items as RefactorFile[]} />,
      },
    },
  ];
}

interface RefactorGroupsSectionProps extends SmellGroupsViewProps {
  t: RefactorT;
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
