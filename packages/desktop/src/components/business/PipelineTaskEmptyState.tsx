import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { useTaskRun } from '../../task-store';
import type { TaskKind } from '../../types/electron';
import type { ScoreDimension } from '@zh/shared';
import { PageShell } from './PageShell';
import { DomainScoreRing } from './DomainScoreRing';

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
  progressLabelKey,
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
  progressLabelKey: string;
  loading: boolean;
  onScan: () => void;
}) {
  const t = useT();
  const { progress, statusMessage } = useTaskRun(taskKind, projectPath);
  return (
    <PageShell
      illustration={<DomainScoreRing projectPath={projectPath} dimension={dimension} />}
      title={t(titleKey)}
      subtitle={t(subtitleKey)}
      featureList={featureList}
      buttonText={t(buttonTextKey)}
      onAction={onScan}
      loading={loading}
      progress={progress}
      progressLabel={t(progressLabelKey)}
      progressMessage={statusMessage}
    />
  );
}
