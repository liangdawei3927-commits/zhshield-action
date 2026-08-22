import type { DimensionDefinition, ScoringConfig } from './types';
import { resolveScoringConfig } from './project-scoring-config';

/**
 * 维度映射器
 * 统一配置，消除与 pipeline-score.ts 的重复
 */
export class DimensionMapper {
  private config: ScoringConfig;

  /**
   * @param config 显式配置（优先级最高）
   * @param projectRoot 项目根目录 — 仅在未显式传入 config 时生效，
   *   用于加载 `.zhshield/scoring.yml` 项目级覆盖；缺省为 process.cwd()
   */
  constructor(config?: ScoringConfig, projectRoot?: string) {
    this.config = config ?? resolveScoringConfig(projectRoot);
  }

  getDimensions(): DimensionDefinition[] {
    return this.config.dimensions;
  }

  getWeightMap(): Record<string, number> {
    const map: Record<string, number> = {};
    for (const dim of this.config.dimensions) {
      map[dim.id] = dim.weight;
    }
    return map;
  }

  getNameMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const dim of this.config.dimensions) {
      map[dim.id] = dim.name;
    }
    return map;
  }

  groupByDimension<T extends { category?: string }>(
    items: T[],
  ): Record<string, T[]> {
    const grouped: Record<string, T[]> = {};
    for (const dim of this.config.dimensions) {
      grouped[dim.id] = [];
    }

    for (const item of items) {
      const dim = item.category ?? 'unknown';
      if (!grouped[dim]) grouped[dim] = [];
      grouped[dim].push(item);
    }

    return grouped;
  }

  validateWeights(): { valid: boolean; sum: number; message?: string } {
    const sum = this.config.dimensions.reduce((s, d) => s + d.weight, 0);
    const valid = Math.abs(sum - 1) < 0.001;
    return {
      valid,
      sum: Math.round(sum * 1000) / 1000,
      message: valid ? undefined : `Dimension weights must sum to 1, got ${sum}`,
    };
  }
}
