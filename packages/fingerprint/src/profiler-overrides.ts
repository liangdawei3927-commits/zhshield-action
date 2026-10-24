// 人工修正合并器（Profiler 拆分重构产物）

import type { UserOverrides, TargetProfile } from './types';

/** merge 结果：修正记录 + 已套用 target 级修正后的画像目标 */
export interface MergeResult {
  readonly overrides: UserOverrides;
  readonly target: TargetProfile;
}

/** 人工修正合并器 */
export class OverrideMerger {
  /**
   * 合并人工修正。
   *
   * target 必须一并返回：修正后的值若只留在局部变量里，调用方拿到的仍是
   * 未修正的原 target，用户手改的语言/形态就永远不生效（此前正是此缺陷）。
   */
  merge(overrides: UserOverrides | undefined, target: TargetProfile): MergeResult {
    if (overrides === undefined) {
      return { overrides: {}, target };
    }

    let merged = target;

    // 如果有 target 级别的修正，合并到当前 target
    if (overrides.targets?.[target.id]) {
      const targetOverride = overrides.targets[target.id];
      if (targetOverride.language !== undefined) {
        merged = {
          ...merged,
          language: {
            value: targetOverride.language,
            confidence: 1.0,
            signals: [],
          },
        };
      }
      if (targetOverride.productForm !== undefined) {
        merged = {
          ...merged,
          productForm: {
            value: targetOverride.productForm,
            confidence: 1.0,
            signals: [],
          },
        };
      }
    }

    return {
      overrides: {
        architecture: overrides.architecture,
        targets: overrides.targets,
        updatedAt: overrides.updatedAt,
      },
      target: merged,
    };
  }
}
