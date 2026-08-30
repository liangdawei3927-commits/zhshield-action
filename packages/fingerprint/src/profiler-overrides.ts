// 人工修正合并器（Profiler 拆分重构产物）

import type { UserOverrides, TargetProfile } from './types';

/** 人工修正合并器 */
export class OverrideMerger {
  /** 合并人工修正 */
  merge(
    overrides: UserOverrides | undefined,
    target: TargetProfile,
  ): UserOverrides {
    if (overrides === undefined) {
      return {};
    }

    // 如果有 target 级别的修正，合并到当前 target
    if (overrides.targets?.[target.id]) {
      const targetOverride = overrides.targets[target.id];
      if (targetOverride.language !== undefined) {
        target = {
          ...target,
          language: {
            value: targetOverride.language,
            confidence: 1.0,
            signals: [],
          },
        };
      }
      if (targetOverride.productForm !== undefined) {
        target = {
          ...target,
          productForm: {
            value: targetOverride.productForm,
            confidence: 1.0,
            signals: [],
          },
        };
      }
    }

    return {
      architecture: overrides.architecture,
      targets: overrides.targets,
      updatedAt: overrides.updatedAt,
    };
  }
}