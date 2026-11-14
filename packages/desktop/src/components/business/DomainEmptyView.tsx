import type { ReactNode } from 'react';
import { PageShell } from './PageShell';
import { DomainScoreRing } from './DomainScoreRing';
import type { ActionRunningKey } from './domain-action-text';
import {
  DOMAIN_REPORT_META,
  defaultActionDomain,
  type ReportDomainKey,
} from '../../pages/domain-report-meta';

export interface DomainEmptyViewProps {
  projectPath: string;
  /**
   * 所属分类域 —— 评分维度与按钮运行态文案从 `DOMAIN_REPORT_META` 取。
   *
   * ⚠️ 评分维度与域键**并不总是同名**：体检域的评分记在 `quality` 维度下，
   * 依赖域记在 `dependencies` 维度下。这张映射表只在本处定义一次，
   * 页面照抄域键即可，不会写错维度。
   */
  domain: ReportDomainKey;
  /**
   * 动作归属覆盖：决定按钮运行态文案（与详情页按钮同源）。
   * 缺省取域键 —— 只有哨兵需要覆盖（监控中 vs 刷新中）。
   */
  actionDomain?: ActionRunningKey;
  title: string;
  subtitle: string;
  features: { icon: ReactNode; title: string; desc: string }[];
  buttonText: string;
  onAction: () => void;
  loading: boolean;
  /** 任务已入队但还没真正开始（按钮显示「排队中…」，进度条显示排队位置） */
  queued?: boolean;
  queuePosition?: number;
  /** 停止当前任务（运行/排队时出现停止按钮） */
  onCancel?: () => void;
  /** 已发出取消、等确认 */
  stopping?: boolean;
  /** 扫描进度 0..1（与任务中心 TaskInfo.progress 同源） */
  progress?: number;
  statusMessage?: string;
  /** 主按钮下方的附加内容（如哨兵的「监控范围」清单） */
  extra?: ReactNode;
}

/** 各域空态统一骨架：DomainScoreRing 插图 + PageShell 版式，仅参数化差异字段 */
export function DomainEmptyView(props: DomainEmptyViewProps) {
  const meta = DOMAIN_REPORT_META[props.domain];
  return (
    <PageShell
      illustration={<DomainScoreRing projectPath={props.projectPath} dimension={meta.dimension} />}
      title={props.title}
      subtitle={props.subtitle}
      featureList={props.features}
      buttonText={props.buttonText}
      onAction={props.onAction}
      actionDomain={props.actionDomain ?? defaultActionDomain(props.domain)}
      loading={props.loading}
      queued={props.queued}
      queuePosition={props.queuePosition}
      onCancel={props.onCancel}
      stopping={props.stopping}
      progress={props.progress}
      progressMessage={props.statusMessage}
      extra={props.extra}
    />
  );
}
