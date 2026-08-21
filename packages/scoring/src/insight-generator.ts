import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { TrendReport } from './types';

/**
 * InsightGenerator — 基于趋势指标生成人类可读的洞察文本
 */
export class InsightGenerator {
  generate({
    scores,
    velocity,
    volatility,
    streak,
    dimensionTrends,
  }: {
    scores: number[];
    velocity: number;
    volatility: number;
    streak: TrendReport['streak'];
    dimensionTrends: TrendReport['dimensionTrends'];
  }, locale?: LanguageCode): string[] {
    const tr = (key: string, params?: Record<string, unknown>) => translate(key, locale ?? DEFAULT_LANGUAGE, params);
    const insights: string[] = [];
    const current = scores.at(-1)!;

    this.pushHealthInsight(insights, current, tr);
    this.pushVelocityInsight(insights, velocity, tr);
    this.pushVolatilityInsight(insights, volatility, tr);
    this.pushStreakInsight(insights, streak, tr);
    this.pushDecliningDimensionInsight(insights, dimensionTrends, tr);

    return insights;
  }

  private pushHealthInsight(insights: string[], current: number, tr: (key: string, params?: Record<string, unknown>) => string): void {
    const message = current >= 90 ? tr('engine.scoring.insight.health.a') :
      current >= 75 ? tr('engine.scoring.insight.health.b') :
      current >= 60 ? tr('engine.scoring.insight.health.c') :
      tr('engine.scoring.insight.health.d');
    insights.push(message);
  }

  private pushVelocityInsight(insights: string[], velocity: number, tr: (key: string, params?: Record<string, unknown>) => string): void {
    const message = velocity > 2 ? tr('engine.scoring.insight.velocity.rising', { velocity: velocity.toFixed(1) }) :
      velocity < -2 ? tr('engine.scoring.insight.velocity.declining', { velocity: velocity.toFixed(1) }) :
      null;
    if (message) insights.push(message);
  }

  private pushVolatilityInsight(insights: string[], volatility: number, tr: (key: string, params?: Record<string, unknown>) => string): void {
    if (volatility > 10) insights.push(tr('engine.scoring.insight.volatility.high'));
    else if (volatility < 3) insights.push(tr('engine.scoring.insight.volatility.low'));
  }

  private pushStreakInsight(insights: string[], streak: TrendReport['streak'], tr: (key: string, params?: Record<string, unknown>) => string): void {
    if (streak.count < 3) return;
    const dir = streak.direction === 'improving' ? tr('engine.scoring.insight.streak.improving') : streak.direction === 'declining' ? tr('engine.scoring.insight.streak.declining') : tr('engine.scoring.insight.streak.stable');
    insights.push(tr('engine.scoring.insight.streak.count', { direction: dir, count: streak.count }));
  }

  private pushDecliningDimensionInsight(insights: string[], dimensionTrends: TrendReport['dimensionTrends'], tr: (key: string, params?: Record<string, unknown>) => string): void {
    const declining = dimensionTrends.filter((d) => d.trend === 'declining');
    if (declining.length === 0) return;
    insights.push(tr('engine.scoring.insight.decliningDimensions', { dimensions: declining.map((d) => d.name).join('、') }));
  }
}
