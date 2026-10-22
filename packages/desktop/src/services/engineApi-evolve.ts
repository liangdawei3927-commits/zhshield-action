/**
 * 引擎 API 分片 — Evolve 演进引擎：建议查询与规则权重自调
 *
 * HTTP 模式直连服务端接口；IPC 桥接缺失时返回空列表兜底。
 */
import type { SuggestionData, RuleWeightData } from '../types/electron';
import {
  getEvolveSuggestionsViaHttp,
  getEvolveWeightsViaHttp,
  autoAdjustWeightsViaHttp,
} from './serverApi';
import { isHttpMode, getAPI } from './engineApi-transport';

// ─── Evolve 演进引擎 ──────────────────────────────────────

export async function getEvolveSuggestions(projectId: string): Promise<SuggestionData[]> {
  if (isHttpMode()) return getEvolveSuggestionsViaHttp(projectId);
  const api = getAPI();
  if (!api?.evolve) return [];
  return api.evolve.getSuggestions(projectId);
}

export async function getEvolveRuleWeights(): Promise<RuleWeightData[]> {
  if (isHttpMode()) return getEvolveWeightsViaHttp();
  const api = getAPI();
  if (!api?.evolve) return [];
  return api.evolve.getRuleWeights();
}

export async function autoAdjustWeights(): Promise<RuleWeightData[]> {
  if (isHttpMode()) return autoAdjustWeightsViaHttp();
  const api = getAPI();
  if (!api?.evolve) return [];
  return api.evolve.autoAdjustWeights();
}
