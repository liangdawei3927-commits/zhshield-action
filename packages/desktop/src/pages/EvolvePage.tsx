import { PageShell } from '../components/business/PageShell';
import { useEvolvePage } from './evolve-logic';
import { NodeGraph, EvolveHeader, EvolveStats, SuggestionsPanel, WeightsPanel, EmptyAnalysisResult } from './evolve-parts';
import { useT } from '../i18n';

interface EvolvePageProps {
  projectPath: string;
}

export function EvolvePage({ projectPath }: EvolvePageProps) {
  const { suggestions, weights, score, loading, analyzed, analyze, highFp, adjustedCount } = useEvolvePage(projectPath);
  const t = useT();

  if (analyzed) {
    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <EvolveHeader
            suggestionCount={suggestions.length}
            weightCount={weights.length}
            loading={loading}
            onRefresh={analyze}
          />
          <EvolveStats
            suggestions={suggestions.length}
            weights={weights.length}
            adjustedCount={adjustedCount}
            highFp={highFp}
          />
          {suggestions.length > 0 || weights.length > 0 ? (
            <div className="flex gap-6">
              <SuggestionsPanel suggestions={suggestions} />
              <WeightsPanel weights={weights} />
            </div>
          ) : (
            <EmptyAnalysisResult score={score} loading={loading} />
          )}
        </div>
      </div>
    );
  }

  return (
    <PageShell
      illustration={<NodeGraph />}
      title={t('page.evolve.empty.title')}
      subtitle={t('page.evolve.empty.subtitle')}
      featureList={[
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
          ),
          title: t('page.evolve.empty.feature.graph.title'),
          desc: t('page.evolve.empty.feature.graph.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
            </svg>
          ),
          title: t('page.evolve.empty.feature.coupling.title'),
          desc: t('page.evolve.empty.feature.coupling.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          ),
          title: t('page.evolve.empty.feature.directory.title'),
          desc: t('page.evolve.empty.feature.directory.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
          ),
          title: t('page.evolve.empty.feature.suggest.title'),
          desc: t('page.evolve.empty.feature.suggest.desc'),
        },
      ]}
      buttonText={t('page.evolve.analyze')}
      onAction={() => void analyze()}
      loading={loading}
    />
  );
}
