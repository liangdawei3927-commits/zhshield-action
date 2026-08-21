/**
 * ProjectProfile → ProjectFeature 投影（纯函数，零 IO，零外部依赖）
 *
 * 架构文档 §11.1：ProjectProfile.toFeature() 投影
 * 从 ProjectProfile 中提取语言 / 框架 / 特性信号，生成
 * SopCacheManager.syncForProject 所需的 ProjectFeature 结构。
 */

import type { ProjectProfile } from './types';

// ─── 返回类型 ───────────────────────────────────────────────────

/**
 * 结构兼容 @zh/kernel 的 ProjectFeature（避免反向依赖 kernel）。
 *
 * kernel 侧定义：`packages/kernel/src/sop/_meta/sop-types.ts` :204
 * ```ts
 * interface ProjectFeature { framework?: string; language?: string; features: string[] }
 * ```
 *
 * 本接口与之结构完全一致，可直接赋值给 `ProjectFeature`。
 */
export interface ProjectFeatureLike {
  framework?: string;
  language?: string;
  features: string[];
}

// ─── 纯函数 ─────────────────────────────────────────────────────

/**
 * 将 ProjectProfile 投影为 ProjectFeature 结构。
 *
 * 映射规则：
 * - `language` ← `targets[0].language.value`（过滤 `'unknown'`）
 * - `framework` ← `targets[0].frameworks[0].value`（取首个）
 * - `features` ← 聚合 productForm / architecture / 环境信号
 *
 * 纯函数：无 IO、无副作用、不修改输入。
 */
export function toFeature(profile: ProjectProfile): ProjectFeatureLike {
  const primary = profile.targets[0];

  if (!primary) {
    return { features: [] };
  }

  const language =
    primary.language.value !== 'unknown' ? primary.language.value : undefined;

  const framework = primary.frameworks[0]?.value;

  const features = collectFeatures(primary, profile);

  return { language, framework, features };
}

// ─── 特性聚合 ───────────────────────────────────────────────────

/**
 * 从目标画像 + 项目画像中聚合特性标签。
 *
 * 聚合维度：
 * 1. 交付物形态（productForm）
 * 2. 架构形态（architecture，过滤 'unknown'）
 * 3. 运行环境（environments）
 */
function collectFeatures(
  primary: ProjectProfile['targets'][number],
  profile: ProjectProfile,
): string[] {
  const features: string[] = [];

  if (primary.productForm) {
    features.push(primary.productForm.value);
  }

  if (profile.architecture.value !== 'unknown') {
    features.push(profile.architecture.value);
  }

  for (const env of profile.environments) {
    features.push(env.value);
  }

  return features;
}
