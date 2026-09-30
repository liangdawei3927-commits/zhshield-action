import { PageShell } from '../components/business/PageShell';
import { DomainScoreRing } from '../components/business/DomainScoreRing';
import { FeatureIcon, LayersGlyph, GridGlyph, ClockGlyph } from '../components/ui/Icons';
import { useT } from '../i18n';

interface EmptyStateProps {
  projectPath: string;
  error: string;
  scanning: boolean;
  progress?: number;
  statusMessage?: string;
  onScan: () => void;
}

/** 空态：引导检查 */
export function RefactorEmptyState({
  projectPath,
  error,
  scanning,
  progress,
  statusMessage,
  onScan,
}: EmptyStateProps) {
  const t = useT();
  return (
    <div className="h-full w-full relative">
      <PageShell
        illustration={<DomainScoreRing projectPath={projectPath} dimension="refactor" />}
        title={t('page.refactor.shell.title')}
        subtitle={t('page.refactor.shell.subtitle')}
        featureList={[
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
        ]}
        buttonText={t('page.refactor.scanNow')}
        onAction={onScan}
        loading={scanning}
        progress={progress}
        progressLabel={t('page.refactor.scanningEllipsis')}
        progressMessage={statusMessage}
      />
      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
        {error ? <p className="text-xs text-danger-500">{error}</p> : null}
      </div>
    </div>
  );
}
