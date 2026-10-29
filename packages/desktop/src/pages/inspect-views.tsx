/**
 * 体检页视图组件（从 InspectPage.tsx 拆出）
 *
 * 承载失败态（InspectFailureView）与空态（InspectEmptyView）两个分支视图；
 * 报告态与页面装配仍留在 InspectPage.tsx。
 */
import { PageShell } from '../components/business/PageShell';
import { DomainScoreRing } from '../components/business/DomainScoreRing';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { FeatureIcon, GridGlyph } from '../components/ui/Icons';
import type { InspectFailure } from './inspect-sop-mapper';

export type Translate = (key: string, params?: Record<string, unknown>) => string;

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
export function InspectFailureView({
  projectPath,
  failure,
  loading,
  progress,
  statusMessage,
  queued,
  queuePosition,
  onRetry,
  t,
}: {
  projectPath: string;
  failure: InspectFailure;
  loading: boolean;
  progress: number;
  statusMessage: string;
  /** 排队中：重试按钮显示「排队中…」而不是「巡检中…」 */
  queued?: boolean;
  queuePosition?: number;
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
      actionDomain="inspect"
      queued={queued}
      queuePosition={queuePosition}
      loading={loading}
      progress={progress}
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

/** 空态：引导发起体检 */
export function InspectEmptyView(props: {
  projectPath: string;
  loading: boolean;
  progress: number;
  statusMessage: string;
  queued?: boolean;
  queuePosition?: number;
  /** 停止本次体检 */
  onCancel: () => void;
  stopping: boolean;
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
      actionDomain="inspect"
      loading={props.loading}
      queued={props.queued}
      queuePosition={props.queuePosition}
      onCancel={props.onCancel}
      stopping={props.stopping}
      progress={props.progress}
      statusMessage={props.statusMessage}
    />
  );
}
