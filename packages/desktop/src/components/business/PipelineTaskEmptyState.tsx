import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { useTaskRun } from '../../task-store';
import type { ScoreDimension } from '../../pages/domain-score-logic';
import { PageShell } from './PageShell';
import { DomainScoreRing } from './DomainScoreRing';

/** 空态功能清单条目（结构与 PageShell 的 FeatureItem 一致） */
interface EmptyStateFeature {
  icon: ReactNode;
  title: string;
  desc: string;
}

/**
 * 复用 pipeline 任务进度的副页空态壳（依赖管家 / 技术债 共用）
 *
 * 这两页未注册独立任务 kind，进度只能自 chain 主链路 pipeline 任务复用；两页的
 * PageShell 装配（接线 + 插图 + 进度换算 + 主按钮 + 进度文案）此前逐字相同，
 * 只有维度、featureList 与文案不同，故收敛到此处。
 */
export function PipelineTaskEmptyState({
  projectPath,
  dimension,
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
  titleKey: string;
  subtitleKey: string;
  featureList: EmptyStateFeature[];
  buttonTextKey: string;
  progressLabelKey: string;
  loading: boolean;
  onScan: () => void;
}) {
  const t = useT();
  // 未注册独立任务 kind 的副页自 chain 主链路 pipeline 任务以复用进度
  const { progress, statusMessage } = useTaskRun('pipeline', projectPath);
  return (
    <PageShell
      illustration={<DomainScoreRing projectPath={projectPath} dimension={dimension} />}
      title={t(titleKey)}
      subtitle={t(subtitleKey)}
      featureList={featureList}
      buttonText={t(buttonTextKey)}
      onAction={onScan}
      loading={loading}
      progress={Math.round(progress * 100)}
      progressLabel={t(progressLabelKey)}
      progressMessage={statusMessage}
    />
  );
}
