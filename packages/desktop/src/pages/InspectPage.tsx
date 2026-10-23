import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { ReportShell } from '../components/business/ReportShell';
import type { ReportStatCard } from '../components/business/ReportShell';
import { DomainScoreRing } from '../components/business/DomainScoreRing';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { FeatureIcon, GridGlyph } from '../components/ui/Icons';
import { useInspectPage } from './inspect-logic';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';
import { useSavedDomainReport } from '../hooks/useSavedDomainReport';
import { selectIssueChecks } from './inspect-sop-mapper';
import type { InspectFailure } from './inspect-sop-mapper';
import { ProgressBar, CheckList } from './inspect-parts';
import type { InspectionReportData } from '../types/electron';

interface InspectPageProps {
  projectPath: string;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * 空态能力卡 — 与体检域（inspect）实跑规则分组严格一一对应，不列他域能力：
 *   架构规范 ← circular-dependency / module-dependency / layer-boundary
 *   模块边界 ← module-boundary / dependency-injection（NestJS）
 *   类型安全 ← type-error-check（真 tsc）/ type-safety / type-consistency / null-safety
 *   代码规范 ← strict-mode / enum-usage
 * 改动前先核对 presets/sop-templates/inspect 下的 active 规则。旧四卡
 * （构建产物 / License / 依赖分析 / 垃圾清理）全部不在体检域，属「宣称了却没查」，
 * 于 2026-09-18 导航各司其职改造（T12）整改为此四组。
 */

/** 架构规范：层叠结构 */
function ArchitectureIcon() {
  return (
    <FeatureIcon>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </FeatureIcon>
  );
}

/** 模块边界：四个独立方块 */
function ModuleBoundaryIcon() {
  return (
    <FeatureIcon>
      <GridGlyph />
    </FeatureIcon>
  );
}

/** 类型安全：盾牌 + 勾 */
function TypeSafetyIcon() {
  return (
    <FeatureIcon>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </FeatureIcon>
  );
}

/** 代码规范：尖括号 */
function CodeStyleIcon() {
  return (
    <FeatureIcon>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </FeatureIcon>
  );
}

/**
 * 失败态：runPipeline 后端报错是 resolve 出来的（不抛异常），此分支是失败唯一的显式信号，
 * 缺了它失败会退化成「从未体检」的空态。
 */
function InspectFailureView({
  projectPath,
  failure,
  loading,
  progress,
  statusMessage,
  onRetry,
  t,
}: {
  projectPath: string;
  failure: InspectFailure;
  loading: boolean;
  progress: number;
  statusMessage: string;
  onRetry: () => void;
  t: Translate;
}) {
  const failureDetail = failure.detail ?? '';

  return (
    <PageShell
      illustration={<DomainScoreRing projectPath={projectPath} dimension="quality" />}
      title={t(failure.messageKey)}
      subtitle={t('page.inspect.empty.subtitle')}
      buttonText={t('page.inspect.errorRetry')}
      onAction={onRetry}
      loading={loading}
      progress={progress}
      progressLabel={t('page.inspect.scanning')}
      progressMessage={statusMessage}
      extra={
        failureDetail.length > 0 ? (
          <p className="mt-4 text-sm text-danger-500 text-center max-w-2xl break-all">
            {failureDetail}
          </p>
        ) : null
      }
    />
  );
}

/**
 * 报告统计卡：总/通过/问题（+ 未检测），明细复用 CheckList。
 * attention（规则引擎 error/skipped → 未检测）计入 items.length 分母却不是问题，
 * 单靠 passed/issues 两张卡会让这批检查彻底不可见，用户无从判断哪些规则根本没跑。
 */
function buildInspectStats({
  items,
  passCount,
  attentionChecks,
  copyToAi,
  copyAllToAi,
  t,
  isSnapshot,
}: {
  items: InspectionReportData['checks'];
  passCount: number;
  attentionChecks: InspectionReportData['checks'];
  copyToAi: (item: InspectionReportData['checks'][number]) => void;
  copyAllToAi: (items: InspectionReportData['checks']) => void;
  t: Translate;
  /** 历史快照（仅问题项）：通过项未落盘，通过数未知 → 显示「—」而非 0 */
  isSnapshot?: boolean;
}): ReportStatCard[] {
  return [
    { key: 'total', label: t('page.inspect.total'), value: isSnapshot ? '—' : items.length },
    {
      key: 'passed',
      label: t('page.inspect.passed'),
      value: isSnapshot ? '—' : passCount,
      color: 'rgb(var(--zh-success))',
      // 快照下明细为空，点开只会是空列表 → 不给 detail（卡片不响应点击）
      ...(isSnapshot
        ? {}
        : {
            detail: {
              items: items.filter((i) => i.status === 'pass'),
              render: (sub: unknown[]) => (
                <CheckList
                  items={sub as InspectionReportData['checks']}
                  onCopyToAi={copyToAi}
                  onCopyAll={copyAllToAi}
                />
              ),
            },
          }),
    },
    {
      key: 'issues',
      label: t('page.inspect.issues'),
      value: selectIssueChecks(items).length,
      color: 'rgb(var(--zh-danger))',
      detail: {
        items: selectIssueChecks(items),
        render: (sub: unknown[]) => (
          <CheckList
            items={sub as InspectionReportData['checks']}
            onCopyToAi={copyToAi}
            onCopyAll={copyAllToAi}
          />
        ),
        hint: t('page.inspect.issuesHint'),
      },
    },
    ...(attentionChecks.length > 0
      ? [
          {
            key: 'attention',
            label: t('page.inspect.attention'),
            value: attentionChecks.length,
            color: 'rgb(var(--zh-muted))',
            detail: {
              items: attentionChecks,
              render: (sub: unknown[]) => (
                <CheckList
                  items={sub as InspectionReportData['checks']}
                  onCopyToAi={copyToAi}
                  onCopyAll={copyAllToAi}
                />
              ),
              hint: t('page.inspect.attentionHint'),
            },
          },
        ]
      : []),
  ];
}

/** 报告态：统计卡 + 通过进度条 */
function InspectReportView({
  projectPath,
  report,
  loading,
  progress,
  statusMessage,
  progressLabel,
  onRescan,
  onBackHome,
  copyToAi,
  copyAllToAi,
  t,
}: {
  projectPath: string;
  report: InspectionReportData;
  loading: boolean;
  progress: number;
  statusMessage: string;
  progressLabel: string;
  onRescan: () => void;
  onBackHome: () => void;
  copyToAi: (item: InspectionReportData['checks'][number]) => void;
  copyAllToAi: (items: InspectionReportData['checks']) => void;
  t: Translate;
}) {
  const items = report.checks;
  const passCount = items.filter((i) => i.status === 'pass').length;
  const attentionChecks = items.filter((i) => i.status === 'attention');
  // 历史快照只落盘问题项 → 通过项未知。此时「总检查/通过」显示「—」，
  // 不用 0 冒充（0 会读成「一项都没通过」，是谎报）。
  const isSnapshot = report.coverage === 'issues-only';

  return (
    <ReportShell
      projectPath={projectPath}
      dimension="quality"
      historyDomain="inspect"
      refreshKey={report}
      icon={
        <PageGlyph bg="warning" stroke="warning">
          <circle cx="11" cy="12" r="2.5" />
          <path d="M13 14l2 2" />
        </PageGlyph>
      }
      title={t('page.inspect.done')}
      action={
        <PrimaryButton
          onClick={onRescan}
          loading={loading}
          loadingLabel={progressLabel || t('page.inspect.scanning')}
        >
          {t('page.inspect.scanNow')}
        </PrimaryButton>
      }
      onBackHome={onBackHome}
      loading={loading}
      progress={progress}
      progressMessage={statusMessage}
      stats={buildInspectStats({
        items,
        passCount,
        attentionChecks,
        copyToAi,
        copyAllToAi,
        t,
        isSnapshot,
      })}
    >
      <p className="text-xs text-zh-muted mb-4">
        {isSnapshot
          ? t('page.inspect.snapshotNote', {
              defaultValue:
                '以上为最近一次巡检的落盘快照，仅保留问题项：通过项未落盘，因此「总检查」「通过」显示为 —。点「重新体检」可获取完整结果。',
            })
          : t('page.inspect.guardAlsoRan')}
      </p>
      {isSnapshot ? null : <ProgressBar passCount={passCount} total={items.length} />}
    </ReportShell>
  );
}

/** 空态：引导发起体检 */
function InspectEmptyView(props: {
  projectPath: string;
  loading: boolean;
  progress: number;
  statusMessage: string;
  onScan: () => void;
  t: Translate;
}) {
  return (
    <DomainEmptyView
      projectPath={props.projectPath}
      dimension="quality"
      title={props.t('page.inspect.empty.title')}
      subtitle={props.t('page.inspect.empty.subtitle')}
      features={[
        {
          icon: <ArchitectureIcon />,
          title: props.t('page.inspect.feature.architecture.title'),
          desc: props.t('page.inspect.feature.architecture.desc'),
        },
        {
          icon: <ModuleBoundaryIcon />,
          title: props.t('page.inspect.feature.moduleBoundary.title'),
          desc: props.t('page.inspect.feature.moduleBoundary.desc'),
        },
        {
          icon: <TypeSafetyIcon />,
          title: props.t('page.inspect.feature.typeSafety.title'),
          desc: props.t('page.inspect.feature.typeSafety.desc'),
        },
        {
          icon: <CodeStyleIcon />,
          title: props.t('page.inspect.feature.codeStyle.title'),
          desc: props.t('page.inspect.feature.codeStyle.desc'),
        },
      ]}
      buttonText={props.t('page.inspect.scanNow')}
      onAction={props.onScan}
      loading={props.loading}
      progress={props.progress}
      statusMessage={props.statusMessage}
      progressLabel={props.t('page.inspect.scanning')}
    />
  );
}

function useInspectPageState(projectPath: string) {
  const page = useInspectPage(projectPath);
  // 打开先落在主页（与改动前一致：那时 report 为空，即使 showHome=false 也停主页）。
  // 读回的历史快照只让「详情按钮可见」，不把人自动带进详情页。
  const [showHome, setShowHome] = useState(true);
  // 实时扫描/每日自动巡检产出结果时进入详情 —— 保持原有「扫完直接看报告」的行为。
  useEffect(() => {
    if (page.report) setShowHome(false);
  }, [page.report]);
  const startScan = () => {
    setShowHome(false);
    page.startInspect();
  };
  const backHome = () => setShowHome(true);
  // 打开详情（回详情分支）——供 DetailEntryProvider.onOpen 使用
  const openDetail = () => setShowHome(false);
  return { ...page, showHome, startScan, backHome, openDetail };
}

export function InspectPage({ projectPath }: InspectPageProps) {
  const t = useT();
  const {
    report,
    persisted,
    failure,
    loading,
    progress,
    progressLabel,
    statusMessage,
    copyToAi,
    copyAllToAi,
    startInspect,
    showHome,
    startScan,
    backHome,
    openDetail,
  } = useInspectPageState(projectPath);

  // 单一判定源：本次实时结果 > 上次扫描的完整报告 > 归一化快照（仅问题项）。
  // 完整报告含通过项 → 数字精确；只有本次修复之前的旧数据才回退到快照。
  // 扫描进行中不拿旧结果顶替，保持「扫描中显示进度空态」的原行为。
  const savedReport = useSavedDomainReport(projectPath, 'inspect', report);
  const detailReport = report ?? (loading ? null : (savedReport ?? persisted));
  const hasDetail = detailReport !== null;

  if (failure) {
    return (
      <InspectFailureView
        projectPath={projectPath}
        failure={failure}
        loading={loading}
        progress={progress}
        statusMessage={statusMessage}
        onRetry={startScan}
        t={t}
      />
    );
  }

  if (detailReport && !showHome) {
    return (
      <InspectReportView
        projectPath={projectPath}
        report={detailReport}
        loading={loading}
        progress={progress}
        statusMessage={statusMessage}
        progressLabel={progressLabel}
        onRescan={startInspect}
        onBackHome={backHome}
        copyToAi={copyToAi}
        copyAllToAi={copyAllToAi}
        t={t}
      />
    );
  }

  return (
    <DetailEntryProvider available={hasDetail} onOpen={openDetail}>
      <InspectEmptyView
        projectPath={projectPath}
        loading={loading}
        progress={progress}
        statusMessage={statusMessage}
        onScan={startScan}
        t={t}
      />
    </DetailEntryProvider>
  );
}
