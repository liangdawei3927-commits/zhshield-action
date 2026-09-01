// 信号计分共享工具：语言/框架/形态维度的最大可能得分计算（Profiler 拆分重构产物）

import type { Signal } from './types';

/** 计分维度 */
export type ScoreDimension = 'language' | 'framework' | 'form';

/** 候选聚合 Map：维度值 → 累计得分 + 支撑信号 */
export type CandidateMap = Map<string, { score: number; signals: Signal[] }>;

/** 向候选 Map 累加信号权重（加权投票核心，语言/框架聚合共用） */
export function accumulateCandidate(candidates: CandidateMap, key: string, signal: Signal): void {
  const existing = candidates.get(key);
  if (existing) {
    existing.score += signal.weight;
    existing.signals.push(signal);
  } else {
    candidates.set(key, { score: signal.weight, signals: [signal] });
  }
}

/** 信号计分器：跨聚合器共享的纯计分逻辑 */
export class SignalScorer {
  /** 计算某维度下所有信号的最大可能得分 */
  static calculateMaxPossibleScore(signals: readonly Signal[], dimension: ScoreDimension): number {
    let maxScore = 0;
    for (const signal of signals) {
      if (SignalScorer.countsForDimension(signal, dimension)) {
        maxScore += signal.weight;
      }
    }
    return maxScore;
  }

  /** 判断信号是否计入某维度 */
  static countsForDimension(signal: Signal, dimension: ScoreDimension): boolean {
    if (dimension === 'language') {
      return (
        (signal.kind === 'manifest' || signal.kind === 'config' || signal.kind === 'ext-stat') &&
        !(signal.kind === 'manifest' && SignalScorer.isFrameworkSignal(signal))
      );
    }
    if (dimension === 'framework') {
      return (
        (signal.kind === 'manifest' || signal.kind === 'config') &&
        !(signal.kind === 'manifest' && !SignalScorer.isFrameworkSignal(signal))
      );
    }
    return signal.kind === 'form';
  }

  /** 判断信号是否携带框架信息 */
  static isFrameworkSignal(signal: Signal): boolean {
    const payload = signal.payload as Record<string, unknown>;
    return typeof payload.framework === 'string';
  }
}
