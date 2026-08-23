import type { ProjectProfile, ProjectType } from '@zh/profiler';

/**
 * 画像驱动评分适配解析器
 *
 * 设计原则（生产/工程角度）：
 * 1. 向后兼容 — profile 为空时返回空覆盖，评分走默认配置，零行为变化
 * 2. 增量而非覆盖 — weightDeltas 在当前权重（默认或项目级 .zhshield/scoring.yml）之上叠加，
 *    profile 做大类适配（后端/前端/小程序），项目配置做细节微调，两者正交可叠加
 * 3. 权重和保持为 1 — 应用增量后归一化，防止漂移
 * 4. 保守调整 — 每类项目只调 2 个维度的权重，避免过度拟合
 *
 * 当前阶段（MVP）：只调权重，不加维度。
 * 中期演进：extraDimensions 字段预留，用于按 profile 启用 ux/observability/api-contract 等维度。
 */
export interface ProfileScoringOverrides {
  /** 权重增量（在当前权重上叠加，非绝对覆盖） */
  weightDeltas?: Partial<Record<string, number>>;
  /** 预留：按 profile 启用的额外维度 id（中期维度池扩展用） */
  extraDimensions?: string[];
  /** 预留：按 profile 禁用的维度 id（如单文件脚本的 architecture） */
  disabledDimensions?: string[];
}

/**
 * 按 ProjectType 的权重增量表
 *
 * 调整依据：
 * - frontend/小程序：前端漏洞公网暴露面小，security 降；performance 归 quality，quality 升
 * - desktop (Electron)：IPC/打包安全风险高，security 升；文档需求低，documentation 降
 * - library：依赖安全由消费者负责，dependencies 降；文档是 API 契约，documentation 升
 * - cli：依赖通常少，dependencies 降；文档降，质量升
 * - app：移动端安全敏感但低于后端，security 微降，quality 升（含性能）
 *
 * 每行增量和 = 0（保持总权重不变，归一化只是兜底）
 */
const TYPE_WEIGHT_DELTAS: Record<ProjectType, Partial<Record<string, number>>> = {
  backend: {},
  frontend: { security: -0.10, quality: +0.10 },
  app: { security: -0.05, quality: +0.05 },
  'mini-program': { dependencies: -0.08, quality: +0.08 },
  desktop: { security: +0.05, documentation: -0.05 },
  library: { dependencies: -0.05, documentation: +0.05 },
  cli: { dependencies: -0.08, documentation: -0.05, quality: +0.13 },
  monorepo: {},
  unknown: {},
};

/**
 * 解析画像 → 评分覆盖。
 * profile 为空或 type=unknown 时返回空对象（向后兼容）。
 */
export function resolveProfileScoring(profile?: ProjectProfile | null): ProfileScoringOverrides {
  if (!profile || profile.type === 'unknown') return {};
  const deltas = TYPE_WEIGHT_DELTAS[profile.type];
  if (!deltas || Object.keys(deltas).length === 0) return {};
  return { weightDeltas: { ...deltas } };
}

/**
 * 将权重增量应用到当前 weightMap 并归一化。
 * 返回新的 weightMap，不修改原对象。
 */
export function applyWeightDeltas(
  weightMap: Record<string, number>,
  deltas: Partial<Record<string, number>> | undefined,
): Record<string, number> {
  if (!deltas || Object.keys(deltas).length === 0) return weightMap;
  const adjusted: Record<string, number> = { ...weightMap };
  for (const [k, delta] of Object.entries(deltas)) {
    adjusted[k] = (adjusted[k] ?? 0) + (delta ?? 0);
  }
  // 归一化，防止浮点漂移导致权重和 ≠ 1
  const sum = Object.values(adjusted).reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (const k of Object.keys(adjusted)) {
      adjusted[k] = Math.round((adjusted[k] / sum) * 1000) / 1000;
    }
  }
  return adjusted;
}
