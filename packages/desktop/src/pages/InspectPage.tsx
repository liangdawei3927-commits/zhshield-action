import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { useInspectPage } from './inspect-logic';
import { MagnifyingGlass, InspectHeader, ProgressBar, CheckList } from './inspect-parts';

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
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

/** 模块边界：四个独立方块 */
function ModuleBoundaryIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

/** 类型安全：盾牌 + 勾 */
function TypeSafetyIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}

/** 代码规范：尖括号 */
function CodeStyleIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

export function InspectPage({ projectPath }: InspectPageProps) {
  const t = useT();
  const { report, loading, progressLabel, copyToAi, copyAllToAi, startInspect } =
    useInspectPage(projectPath);

  if (report && report.checks.length > 0) {
    const items = report.checks;
    const passCount = items.filter((i) => i.status === 'pass').length;

    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <InspectHeader
            passCount={passCount}
            total={items.length}
            loading={loading}
            progressLabel={progressLabel}
            onRescan={startInspect}
          />
          <ProgressBar passCount={passCount} total={items.length} />
          <CheckList items={items} onCopyToAi={copyToAi} onCopyAll={copyAllToAi} />
        </div>
      </div>
    );
  }

  return (
    <PageShell
      illustration={<MagnifyingGlass />}
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
      onAction={startInspect}
      loading={loading}
      progressLabel={progressLabel || t('page.inspect.scanning')}
    />
  );
}
