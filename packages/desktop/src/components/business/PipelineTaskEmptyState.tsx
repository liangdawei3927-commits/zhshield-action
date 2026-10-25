import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { useTaskRun } from '../../task-store';
import type { TaskKind } from '../../types/electron';
import type { ScoreDimension } from '@zh/shared';
import { PageShell } from './PageShell';
import { DomainScoreRing } from './DomainScoreRing';
import type { ActionRunningKey } from './domain-action-text';

/** 空态功能清单条目（结构与 PageShell 的 FeatureItem 一致） */
interface EmptyStateFeature {
  icon: ReactNode;
  title: string;
  desc: string;
}

/**
 * 副页空态壳（依赖管家 / 技术债 共用）：进度订阅调用方传入的本域 taskKind。
 *
 * 两页的 PageShell 装配（接线 + 插图 + 进度换算 + 主按钮 + 进度文案）逐字相同，
 * 只有维度、taskKind、featureList 与文案不同，故收敛到此处。
 */
export function PipelineTaskEmptyState({
  projectPath,
  dimension,
  taskKind,
  titleKey,
  subtitleKey,
  featureList,
  buttonTextKey,
  actionDomain,
  loading,
  onScan,
}: {
  projectPath: string;
  dimension: ScoreDimension;
  taskKind: TaskKind;
  titleKey: string;
  subtitleKey: string;
  featureList: EmptyStateFeature[];
  buttonTextKey: string;
  /** 动作归属：决定按钮运行态文案（与详情页按钮同源） */
  actionDomain: ActionRunningKey;
  loading: boolean;
  onScan: () => void;
}) {
  const t = useT();
  // 排队/停止都由本组件自己订阅（调用方已经传了 taskKind），无需各页再接线
  const { progress, statusMessage, queued, queuePosition, cancel, stopping } = useTaskRun(
    taskKind,
    projectPath,
  );
  return (
    <PageShell
      illustration={<DomainScoreRing projectPath={projectPath} dimension={dimension} />}
      title={t(titleKey)}
      subtitle={t(subtitleKey)}
      featureList={featureList}
      buttonText={t(buttonTextKey)}
      onAction={onScan}
      actionDomain={actionDomain}
      loading={loading}
      queued={queued}
      queuePosition={queuePosition}
      // 依赖/技术债的执行器不在 pipeline 子进程里（走 profile-host + 主进程），
      // 取消只能做到"立刻止损、结果不再采用"，无法杀进程。UI 语义一致即可。
      onCancel={cancel}
      stopping={stopping}
      progress={progress}
      progressMessage={statusMessage}
    />
  );
}
