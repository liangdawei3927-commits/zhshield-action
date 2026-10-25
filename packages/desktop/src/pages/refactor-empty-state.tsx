import type { ComponentProps } from 'react';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { FeatureIcon, LayersGlyph, GridGlyph, ClockGlyph } from '../components/ui/Icons';
import { useT } from '../i18n';

interface EmptyStateProps {
  projectPath: string;
  error: string;
  scanning: boolean;
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
  return [
    {
      icon: (
        <FeatureIcon>
          <LayersGlyph />
        </FeatureIcon>
      ),
      title: t('page.refactor.shell.featureSmell.title'),
      desc: t('page.refactor.shell.featureSmell.desc'),
    },
    {
      icon: (
        <FeatureIcon>
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </FeatureIcon>
      ),
      title: t('page.refactor.shell.featureAutoFix.title'),
      desc: t('page.refactor.shell.featureAutoFix.desc'),
    },
    {
      icon: (
        <FeatureIcon>
          <ClockGlyph />
        </FeatureIcon>
      ),
      title: t('page.refactor.shell.featureDaily.title'),
      desc: t('page.refactor.shell.featureDaily.desc'),
    },
    {
      icon: (
        <FeatureIcon>
          <GridGlyph />
        </FeatureIcon>
      ),
      title: t('page.refactor.shell.featureGrouping.title'),
      desc: t('page.refactor.shell.featureGrouping.desc'),
    },
  ];
}

/** 空态：引导检查 */
export function RefactorEmptyState(props: EmptyStateProps) {
  const t = useT();
  return (
    <div className="h-full w-full relative">
      <DomainEmptyView
        projectPath={props.projectPath}
        dimension="refactor"
        title={t('page.refactor.shell.title')}
        subtitle={t('page.refactor.shell.subtitle')}
        features={buildRefactorFeatures(t)}
        buttonText={t('page.refactor.scanNow')}
        onAction={props.onScan}
        actionDomain="refactor"
        queued={props.queued}
        queuePosition={props.queuePosition}
        onCancel={props.onCancel}
        stopping={props.stopping}
        loading={props.scanning}
        progress={props.progress}
        statusMessage={props.statusMessage}
      />
      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
        {props.error ? <p className="text-xs text-danger-500">{props.error}</p> : null}
      </div>
    </div>
  );
}
