import { useState } from 'react';
import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { ReportShell } from '../components/business/ReportShell';
import type { ReportStatCard } from '../components/business/ReportShell';
import { DomainScoreRing } from '../components/business/DomainScoreRing';
import { PageGlyph } from '../components/business/page-glyph';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { FeatureIcon, GridGlyph } from '../components/ui/Icons';
import { useInspectPage } from './inspect-logic';
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
      progress={Math.round(progress * 100)}
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
}: {
  items: InspectionReportData['checks'];
  passCount: number;
  attentionChecks: InspectionReportData['checks'];
  copyToAi: (item: InspectionReportData['checks'][number]) => void;
  copyAllToAi: (items: InspectionReportData['checks']) => void;
  t: Translate;
}): ReportStatCard[] {
  return [
    { key: 'total', label: t('page.inspect.total'), value: items.length },
    {
      key: 'passed',
      label: t('page.inspect.passed'),
      value: passCount,
      color: 'rgb(var(--zh-success))',
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

  return (
    <ReportShell
      projectPath={projectPath}
      dimension="quality"
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
      stats={buildInspectStats({ items, passCount, attentionChecks, copyToAi, copyAllToAi, t })}
    >
      <p className="text-xs text-zh-muted mb-4">{t('page.inspect.guardAlsoRan')}</p>
      <ProgressBar passCount={passCount} total={items.length} />
    </ReportShell>
  );
}

/** 空态：引导发起体检 */
function InspectEmptyView({
  projectPath,
  loading,
  progress,
  statusMessage,
  onScan,
  t,
}: {
  projectPath: string;
  loading: boolean;
  progress: number;
  statusMessage: string;
  onScan: () => void;
  t: Translate;
}) {
  return (
    <PageShell
      illustration={<DomainScoreRing projectPath={projectPath} dimension="quality" />}
      title={t('page.inspect.empty.title')}
      subtitle={t('page.inspect.empty.subtitle')}
      featureList={[
        {
          icon: <ArchitectureIcon />,
          title: t('page.inspect.feature.architecture.title'),
          desc: t('page.inspect.feature.architecture.desc'),
        },
        {
          icon: <ModuleBoundaryIcon />,
          title: t('page.inspect.feature.moduleBoundary.title'),
          desc: t('page.inspect.feature.moduleBoundary.desc'),
        },
        {
          icon: <TypeSafetyIcon />,
          title: t('page.inspect.feature.typeSafety.title'),
          desc: t('page.inspect.feature.typeSafety.desc'),
        },
        {
          icon: <CodeStyleIcon />,
          title: t('page.inspect.feature.codeStyle.title'),
          desc: t('page.inspect.feature.codeStyle.desc'),
        },
      ]}
      buttonText={t('page.inspect.scanNow')}
      onAction={onScan}
      loading={loading}
      progress={Math.round(progress * 100)}
      progressLabel={t('page.inspect.scanning')}
      progressMessage={statusMessage}
    />
  );
}

export function InspectPage({ projectPath }: InspectPageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(false);
  const {
    report,
    failure,
    loading,
    progress,
    progressLabel,
    statusMessage,
    copyToAi,
    copyAllToAi,
    startInspect,
  } = useInspectPage(projectPath);

  const startScan = () => {
    setShowHome(false);
    startInspect();
  };

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

  if (report && report.checks.length > 0 && !showHome) {
    return (
      <InspectReportView
        projectPath={projectPath}
        report={report}
        loading={loading}
        progressLabel={progressLabel}
        onRescan={startInspect}
        onBackHome={() => setShowHome(true)}
        copyToAi={copyToAi}
        copyAllToAi={copyAllToAi}
        t={t}
      />
    );
  }

  return (
    <InspectEmptyView
      projectPath={projectPath}
      loading={loading}
      progress={progress}
      statusMessage={statusMessage}
      onScan={startScan}
      t={t}
    />
  );
}
