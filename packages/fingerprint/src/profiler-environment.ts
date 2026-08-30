// 环境/包管理器聚合器（Profiler 拆分重构产物）

import type { Signal, MatchResult } from './types';

/** 环境聚合结果 */
export interface EnvironmentAggregation {
  readonly environments: readonly MatchResult<string>[];
  readonly packageManager: MatchResult<string> | undefined;
}

/** 环境与包管理器聚合器 */
export class EnvironmentAggregator {
  /** 聚合环境与包管理器信号 */
  aggregate(signals: readonly Signal[]): EnvironmentAggregation {
    return {
      environments: this.aggregateEnvironments(signals),
      packageManager: this.aggregatePackageManager(signals),
    };
  }

  /** 聚合环境信号 */
  private aggregateEnvironments(signals: readonly Signal[]): readonly MatchResult<string>[] {
    const environments = new Map<string, { score: number; signals: Signal[] }>();

    for (const signal of signals) {
      if (signal.kind !== 'config') continue;
      const payload = signal.payload as Record<string, unknown>;
      if (typeof payload.environment !== 'string') continue;

      const env = payload.environment;
      const existing = environments.get(env);
      if (existing) {
        existing.score += signal.weight;
        existing.signals.push(signal);
      } else {
        environments.set(env, { score: signal.weight, signals: [signal] });
      }
    }

    const results: MatchResult<string>[] = [];
    for (const [env, { signals: sigs }] of environments) {
      // 环境信号置信度固定为 1.0（config 信号权重高）
      results.push({ value: env, confidence: 1.0, signals: sigs });
    }

    return results;
  }

  /** 聚合包管理器信号 */
  private aggregatePackageManager(signals: readonly Signal[]): MatchResult<string> | undefined {
    for (const signal of signals) {
      if (signal.kind !== 'manifest') continue;
      if (!signal.ruleId.startsWith('manifest:package-manager:')) continue;

      const manager = signal.ruleId.replace('manifest:package-manager:', '');
      return {
        value: manager,
        confidence: 1.0,
        signals: [signal],
      };
    }

    return undefined;
  }
}