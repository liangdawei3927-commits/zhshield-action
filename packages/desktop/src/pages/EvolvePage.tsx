import { PageShell } from '../components/business/PageShell';
import { FeatureIcon, LayersGlyph, GridGlyph } from '../components/ui/Icons';
import { useEvolvePage } from './evolve-logic';
import {
  NodeGraph,
  EvolveHeader,
  EvolveStats,
  SuggestionsPanel,
  WeightsPanel,
  EmptyAnalysisResult,
} from './evolve-parts';
import { useT } from '../i18n';

interface EvolvePageProps {
  projectPath: string;
}

export function EvolvePage({ projectPath }: EvolvePageProps) {
  const { suggestions, weights, score, loading, analyzed, analyze, highFp, adjustedCount } =
    useEvolvePage(projectPath);
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
      featureList={evolveFeatureList(t)}
      buttonText={t('page.evolve.analyze')}
      onAction={() => void analyze()}
      actionDomain="evolve"
      loading={loading}
    />
  );
}

function evolveFeatureList(t: ReturnType<typeof useT>) {
  return [
    {
      icon: (
        <FeatureIcon>
          <LayersGlyph />
        </FeatureIcon>
      ),
      title: t('page.evolve.empty.feature.graph.title'),
      desc: t('page.evolve.empty.feature.graph.desc'),
    },
    {
      icon: (
        <FeatureIcon>
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </FeatureIcon>
      ),
      title: t('page.evolve.empty.feature.coupling.title'),
      desc: t('page.evolve.empty.feature.coupling.desc'),
    },
    {
      icon: (
        <FeatureIcon>
          <GridGlyph />
        </FeatureIcon>
      ),
      title: t('page.evolve.empty.feature.directory.title'),
      desc: t('page.evolve.empty.feature.directory.desc'),
    },
    {
      icon: (
        <FeatureIcon>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
        </FeatureIcon>
      ),
      title: t('page.evolve.empty.feature.suggest.title'),
      desc: t('page.evolve.empty.feature.suggest.desc'),
    },
  ];
}
