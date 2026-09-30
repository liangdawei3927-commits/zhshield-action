import { useState } from 'react';
import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { ReportShell } from '../components/business/ReportShell';
import { DomainScoreRing } from '../components/business/DomainScoreRing';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { FeatureIcon, GridGlyph } from '../components/ui/Icons';
import { useInspectPage } from './inspect-logic';
import { selectIssueChecks } from './inspect-sop-mapper';
import { ProgressBar, CheckList } from './inspect-parts';
import type { InspectionReportData } from '../types/electron';

interface InspectPageProps {
  projectPath: string;
}

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

export function InspectPage({ projectPath }: InspectPageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(false);
  const {
    report,
    loading,
    progress,
    progressLabel,
    statusMessage,
    copyToAi,
    copyAllToAi,
    startInspect,
  } = useInspectPage(projectPath);

  if (report && report.checks.length > 0 && !showHome) {
    const items = report.checks;
    const passCount = items.filter((i) => i.status === 'pass').length;

    return (
      <ReportShell
        projectPath={projectPath}
        dimension="quality"
        refreshKey={report}
        icon={
          <Bounce className="w-14 h-14 rounded-xl bg-warning-50 flex items-center justify-center">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="rgb(var(--zh-warning))"
              strokeWidth="2"
            >
              <circle cx="11" cy="12" r="2.5" />
              <path d="M13 14l2 2" />
            </svg>
          </Bounce>
        }
        title={t('page.inspect.done')}
        action={
          <PrimaryButton
            onClick={startInspect}
            loading={loading}
            loadingLabel={progressLabel || t('page.inspect.scanning')}
          >
            {t('page.inspect.scanNow')}
          </PrimaryButton>
        }
        onBackHome={() => setShowHome(true)}
        stats={[
          { key: 'total', label: t('page.inspect.total'), value: items.length },
          {
            key: 'passed',
            label: t('page.inspect.passed'),
            value: passCount,
            color: 'rgb(var(--zh-success))',
            detail: {
              items: items.filter((i) => i.status === 'pass'),
              render: (sub) => (
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
              render: (sub) => (
                <CheckList
                  items={sub as InspectionReportData['checks']}
                  onCopyToAi={copyToAi}
                  onCopyAll={copyAllToAi}
                />
              ),
              hint: t('page.inspect.issuesHint'),
            },
          },
        ]}
      >
        <p className="text-xs text-zh-muted mb-4">{t('page.inspect.guardAlsoRan')}</p>
        <ProgressBar passCount={passCount} total={items.length} />
      </ReportShell>
    );
  }

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
      onAction={() => {
        setShowHome(false);
        startInspect();
      }}
      loading={loading}
      progress={Math.round(progress * 100)}
      progressLabel={t('page.inspect.scanning')}
      progressMessage={statusMessage}
    />
  );
}
