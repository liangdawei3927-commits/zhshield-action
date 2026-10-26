import type { ReactNode } from 'react';
import type { ScoreDimension } from '@zh/shared';
import { PageShell } from './PageShell';
import { DomainScoreRing } from './DomainScoreRing';
import type { ActionRunningKey } from './domain-action-text';

export interface DomainEmptyViewProps {
  projectPath: string;
  dimension: ScoreDimension;
  /** 动作归属：决定按钮运行态文案（与详情页按钮同源） */
  actionDomain: ActionRunningKey;
  title: string;
  subtitle: string;
  features: { icon: ReactNode; title: string; desc: string }[];
  buttonText: string;
  onAction: () => void;
  loading: boolean;
  /** 任务已入队但还没真正开始（按钮显示「排队中…」，进度条显示排队位置） */
  queued?: boolean;
  queuePosition?: number;
  /** 活跃任务是每日自动巡检发起的：按钮/进度条显示「自动巡检」 */
  autoActive?: boolean;
  /** 停止当前任务（运行/排队时出现停止按钮） */
  onCancel?: () => void;
  /** 已发出取消、等确认 */
  stopping?: boolean;
  /** 扫描进度 0..1（与任务中心 TaskInfo.progress 同源） */
  progress?: number;
  statusMessage?: string;
}

/** 各域空态统一骨架：DomainScoreRing 插图 + PageShell 版式，仅参数化差异字段 */
export function DomainEmptyView(props: DomainEmptyViewProps) {
  return (
    <PageShell
      illustration={<DomainScoreRing projectPath={props.projectPath} dimension={props.dimension} />}
      title={props.title}
      subtitle={props.subtitle}
      featureList={props.features}
      buttonText={props.buttonText}
      onAction={props.onAction}
      actionDomain={props.actionDomain}
      loading={props.loading}
      queued={props.queued}
      queuePosition={props.queuePosition}
      autoActive={props.autoActive}
      onCancel={props.onCancel}
      stopping={props.stopping}
      progress={props.progress}
      progressMessage={props.statusMessage}
    />
  );
}
