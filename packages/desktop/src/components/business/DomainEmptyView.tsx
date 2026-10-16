import type { ReactNode } from 'react';
import type { ScoreDimension } from '@zh/shared';
import { PageShell } from './PageShell';
import { DomainScoreRing } from './DomainScoreRing';

export interface DomainEmptyViewProps {
  projectPath: string;
  dimension: ScoreDimension;
  title: string;
  subtitle: string;
  features: { icon: ReactNode; title: string; desc: string }[];
  buttonText: string;
  onAction: () => void;
  loading: boolean;
  progress?: number;
  progressLabel?: string;
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
      loading={props.loading}
      progress={props.progress}
      progressLabel={props.progressLabel}
      progressMessage={props.statusMessage}
    />
  );
}
