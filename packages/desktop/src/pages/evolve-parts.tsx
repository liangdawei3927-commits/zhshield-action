import type { SuggestionData, RuleWeightData } from '../types/electron';
import { Bounce, BounceCard } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { getScoreColor } from './reports-logic';
import { useT } from '../i18n';

/** 节点树 SVG（线性风格） */
export function NodeGraph() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-info) / 0.05)" />
      {/* 节点连线 */}
      <line x1="75" y1="35" x2="45" y2="70" stroke="rgb(var(--zh-info) / 0.2)" strokeWidth="1.2" />
      <line x1="75" y1="35" x2="105" y2="70" stroke="rgb(var(--zh-info) / 0.2)" strokeWidth="1.2" />
      <line x1="45" y1="70" x2="60" y2="105" stroke="rgb(var(--zh-info) / 0.2)" strokeWidth="1.2" />
      <line
        x1="105"
        y1="70"
        x2="90"
        y2="105"
        stroke="rgb(var(--zh-info) / 0.2)"
        strokeWidth="1.2"
      />
      <line x1="60" y1="105" x2="90" y2="105" stroke="rgb(var(--zh-info) / 0.15)" strokeWidth="1" />
      {/* 节点 */}
      <circle cx="75" cy="35" r="8" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="2" />
      <circle cx="45" cy="70" r="6" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="1.5" />
      <circle cx="105" cy="70" r="6" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="1.5" />
      <circle cx="60" cy="105" r="5" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="1.2" />
      <circle cx="90" cy="105" r="5" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="1.2" />
    </svg>
  );
}

export function EvolveHeader({
  suggestionCount,
  weightCount,
  loading,
  onRefresh,
}: {
  suggestionCount: number;
  weightCount: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-8">
      <Bounce className="w-12 h-12 rounded-xl bg-cyan-50 flex items-center justify-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(var(--zh-info))"
          strokeWidth="1.8"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06" />
          <path d="M4.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06" />
        </svg>
      </Bounce>
      <div>
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.evolve.title')}</h1>
        <p className="text-sm text-zh-muted">
          {t('page.evolve.header.count', { suggestions: suggestionCount, weights: weightCount })}
        </p>
      </div>
      <PrimaryButton
        className="ml-auto"
        onClick={onRefresh}
        loading={loading}
        loadingLabel={t('common.loading')}
      >
        {t('common.refresh')}
      </PrimaryButton>
    </div>
  );
}

export function EvolveStats({
  suggestions,
  weights,
  adjustedCount,
  highFp,
}: {
  suggestions: number;
  weights: number;
  adjustedCount: number;
  highFp: number;
}) {
  const t = useT();
  return (
    <div className="flex gap-4 mb-6">
      {[
        {
          labelKey: 'page.evolve.stats.suggestions',
          value: String(suggestions),
          color: 'rgb(var(--zh-info))',
        },
        {
          labelKey: 'page.evolve.stats.weights',
          value: String(weights),
          color: 'rgb(var(--zh-info))',
        },
        {
          labelKey: 'page.evolve.stats.adjusted',
          value: String(adjustedCount),
          color: 'rgb(var(--zh-warning))',
        },
        {
          labelKey: 'page.evolve.stats.highFp',
          value: String(highFp),
          color: 'rgb(var(--zh-danger))',
        },
      ].map((stat) => (
        <ResultCard key={stat.labelKey} variant="stats" className="flex-1">
          <div className="text-xs text-zh-muted">{t(stat.labelKey)}</div>
          <div className="text-2xl font-bold mt-1" style={{ color: stat.color }}>
            {stat.value}
          </div>
        </ResultCard>
      ))}
    </div>
  );
}

export function SuggestionsPanel({ suggestions }: { suggestions: SuggestionData[] }) {
  const t = useT();
  return (
    <div className="flex-1">
      <h3 className="text-sm font-semibold text-zh-ink-2 mb-3">
        {t('page.evolve.stats.suggestions')}
      </h3>
      <div className="space-y-2">
        {suggestions.map((s) => (
          <BounceCard key={s.ruleId} className="p-3 rounded-lg bg-zh-panel">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-info-50 text-info-600">
                {s.ruleId}
              </span>
              <span className="text-xs text-zh-muted">
                {t('page.evolve.suggestion.confidence', {
                  confidence: Math.round(s.confidence * 100),
                })}
              </span>
            </div>
            <div className="text-sm text-zh-ink-2">{s.message}</div>
          </BounceCard>
        ))}
      </div>
    </div>
  );
}

export function WeightsPanel({ weights }: { weights: RuleWeightData[] }) {
  const t = useT();
  return (
    <div className="flex-1">
      <h3 className="text-sm font-semibold text-zh-ink-2 mb-3">{t('page.evolve.weights')}</h3>
      <div className="space-y-2">
        {weights.map((w) => {
          const barColor =
            w.weight >= 0.8
              ? 'rgb(var(--zh-success))'
              : w.weight >= 0.5
                ? 'rgb(var(--zh-warning))'
                : 'rgb(var(--zh-danger))';
          return (
            <BounceCard key={w.ruleId} className="p-3 rounded-lg bg-zh-panel">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-mono text-info-600">{w.ruleId}</span>
                <span className="text-xs font-medium" style={{ color: barColor }}>
                  {(w.weight * 100).toFixed(0)}%
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-zh-line">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${w.weight * 100}%`, background: barColor }}
                />
              </div>
              <div className="flex justify-between mt-1 text-xs text-zh-muted">
                <span>
                  {t('page.evolve.weight.fpRate', { rate: (w.falsePositiveRate * 100).toFixed(0) })}
                </span>
                <span>{t('page.evolve.weight.samples', { samples: w.totalSamples })}</span>
              </div>
            </BounceCard>
          );
        })}
      </div>
    </div>
  );
}

/** 分析完成但暂无建议/权重数据时的结果占位：架构健康度 + 引导 */
export function EmptyAnalysisResult({
  score,
  loading,
}: {
  score: number | null;
  loading: boolean;
}) {
  const t = useT();
  const color = score === null ? 'rgb(var(--zh-muted))' : getScoreColor(score);
  return (
    <ResultCard variant="item" className="p-10 text-center">
      {loading ? (
        <div className="text-sm text-zh-muted py-8">{t('page.evolve.emptyAnalyzing')}</div>
      ) : (
        <div className="flex flex-col items-center gap-3 py-4">
          <div>
            <div className="text-xs text-zh-muted mb-1">{t('page.evolve.archScore')}</div>
            <div className="text-4xl font-bold" style={{ color }}>
              {score ?? '--'}
            </div>
          </div>
          <div className="text-sm font-medium text-zh-ink-2">{t('page.evolve.emptyDone')}</div>
          <div className="text-xs text-zh-muted max-w-md leading-relaxed">
            {t('page.evolve.emptyHint')}
          </div>
        </div>
      )}
    </ResultCard>
  );
}
