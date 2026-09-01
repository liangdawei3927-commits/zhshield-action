import { useCallback, useState } from 'react';
import { getEvolveSuggestions, getEvolveRuleWeights, getScore } from '../services/engineApi';
import type { HealthScoreData, RuleWeightData, SuggestionData } from '../types/electron';

/** 由规则权重派生统计：高误报率规则数 / 已调整权重规则数 */
function computeWeightStats(weights: RuleWeightData[]): { highFp: number; adjustedCount: number } {
  const highFp = weights.filter((w) => w.falsePositiveRate > 0.3).length;
  const adjustedCount = weights.filter((w) => w.weight < 1.0).length;
  return { highFp, adjustedCount };
}

/** 演进建议加载：建议列表状态 + 拉取 */
function useEvolveSuggestions(projectPath: string): {
  suggestions: SuggestionData[];
  loadSuggestions: () => Promise<void>;
} {
  const [suggestions, setSuggestions] = useState<SuggestionData[]>([]);
  const loadSuggestions = useCallback(async () => {
    setSuggestions(await getEvolveSuggestions(projectPath));
  }, [projectPath]);
  return { suggestions, loadSuggestions };
}

/** 规则权重加载：权重列表状态 + 拉取 */
function useEvolveWeights(): {
  weights: RuleWeightData[];
  loadWeights: () => Promise<void>;
} {
  const [weights, setWeights] = useState<RuleWeightData[]>([]);
  const loadWeights = useCallback(async () => {
    setWeights(await getEvolveRuleWeights());
  }, []);
  return { weights, loadWeights };
}

/** 架构健康度：最新评分的 architecture 维度 */
function useArchitectureScore(projectPath: string): {
  score: number | null;
  loadScore: () => Promise<void>;
} {
  const [score, setScore] = useState<number | null>(null);
  const loadScore = useCallback(async () => {
    const health: HealthScoreData | null = await getScore(projectPath);
    const architecture = health?.dimensions.find((d) => d.name === 'architecture');
    setScore(architecture ? Math.round(architecture.score) : null);
  }, [projectPath]);
  return { score, loadScore };
}

/** 演进页状态：点击「架构分析」后进入结果视图（无论是否有建议数据） */
export function useEvolvePage(projectPath: string) {
  const { suggestions, loadSuggestions } = useEvolveSuggestions(projectPath);
  const { weights, loadWeights } = useEvolveWeights();
  const { score, loadScore } = useArchitectureScore(projectPath);
  const [loading, setLoading] = useState(false);
  const [analyzed, setAnalyzed] = useState(false);

  const analyze = useCallback(async () => {
    setAnalyzed(true);
    setLoading(true);
    try {
      await Promise.all([loadSuggestions(), loadWeights(), loadScore()]);
    } catch {
      // 任一数据源失败不阻断其余展示
    } finally {
      setLoading(false);
    }
  }, [loadSuggestions, loadWeights, loadScore]);

  return {
    suggestions,
    weights,
    score,
    loading,
    analyzed,
    analyze,
    ...computeWeightStats(weights),
  };
}
