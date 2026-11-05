import type { ComponentProps } from 'react';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { FeatureIcon, LayersGlyph, GridGlyph } from '../components/ui/Icons';
import {
  buildCapabilityFeatures,
  buildPlannedCapabilities,
} from '../components/business/capability-features';
import { useT } from '../i18n';

interface EmptyStateProps {
  projectPath: string;
  error: string;
  loading: boolean;
  /** 扫描进度 0..1（与任务中心 TaskInfo.progress 同源） */
  progress?: number;
  statusMessage?: string;
  /** 任务已入队但还没真正开始（按钮显示「排队中…」） */
  queued?: boolean;
  queuePosition?: number;
  /** 停止本次重构扫描（运行/排队时按钮旁出现「停止」） */
  onCancel: () => void;
  /** 已发出取消、等确认 */
  stopping: boolean;
  onScan: () => void;
}

/** 构建重构空态的特色说明列表 */
function buildRefactorFeatures(
  t: ReturnType<typeof useT>,
): ComponentProps<typeof DomainEmptyView>['features'] {
  // 注册表决定**渲染哪几项**（只渲染 status='implemented' 的）。
  // 「一键应用推荐重构方案」（refactor.auto-fix）现已落地（2026-11-03）：
  // 桌面端入口 + 写盘前自动备份。其余种类的能力若仍是 planned/deprecated，
  // 会自动落到下方「规划中」灰显区，不会混进这里。
  // 「每日自动检查」「按类别分组」是运行形态而非检测能力，由页面自身承载，不入注册表。
  return buildCapabilityFeatures('refactor', {
    icons: {
      'refactor.smells': (
        <FeatureIcon>
          <LayersGlyph />
        </FeatureIcon>
      ),
      'refactor.duplicate-code': (
        <FeatureIcon>
          <GridGlyph />
        </FeatureIcon>
      ),
      'refactor.auto-fix': (
        <FeatureIcon>
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </FeatureIcon>
      ),
    },
    descriptions: {
      'refactor.smells': t('page.refactor.shell.featureSmell.desc'),
      'refactor.duplicate-code': t('page.refactor.shell.featureGrouping.desc'),
    },
  });
}

/** 空态：引导检查 */
export function RefactorEmptyState(props: EmptyStateProps) {
  const t = useT();
  return (
    <div className="h-full w-full relative">
      <DomainEmptyView
        projectPath={props.projectPath}
        domain="refactor"
        title={t('page.refactor.shell.title')}
        subtitle={t('page.refactor.shell.subtitle')}
        features={buildRefactorFeatures(t)}
        planned={buildPlannedCapabilities('refactor')}
        buttonText={t('page.refactor.scanNow')}
        onAction={props.onScan}
        actionDomain="refactor"
        queued={props.queued}
        queuePosition={props.queuePosition}
        onCancel={props.onCancel}
        stopping={props.stopping}
        loading={props.loading}
        progress={props.progress}
        statusMessage={props.statusMessage}
      />
      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
        {props.error ? <p className="text-xs text-danger-500">{props.error}</p> : null}
      </div>
    </div>
  );
}
