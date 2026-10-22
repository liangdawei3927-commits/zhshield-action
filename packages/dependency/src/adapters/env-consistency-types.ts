/**
 * 环境一致性检查 —— 共享类型定义（env-consistency-types.ts）
 *
 * 由 env-consistency.ts 拆出：仅承载公开类型，
 * 供 env-consistency.ts（中枢）与各检查实现模块单向引用。
 */
import type { ProjectProfile } from '@zh/shared';

/** 环境一致性检查选项：projectRoot 为清单所在目录（默认取 profile.projectPath） */
export interface EnvConsistencyOptions {
  projectRoot: string;
}

/** 环境一致性报告：entries 为空数组表示无任何偏差 */
export interface EnvConsistencyReport {
  entries: EnvEntry[];
}

/** 单条环境偏差条目 */
export interface EnvEntry {
  /** 偏差类别 */
  kind: 'lockfile-drift' | 'runtime-version' | 'env-file-diff' | 'ci-vs-local';
  /** 条目名称（包名 / 运行时 / 环境变量 / 工作流） */
  name: string;
  /** 期望值（声明 / 示例 / 本地清单） */
  expected: string;
  /** 实际值（锁文件 / 文件内容 / CI 配置） */
  actual: string;
  /** 严重度：error=阻断，warning=提示，info=信息 */
  severity: 'error' | 'warning' | 'info';
  /** 人类可读说明（UI 直接展示） */
  detail: string;
}

/** 环境一致性检查器契约（对齐规格附 B.3(4) ④） */
export interface EnvConsistencyChecker {
  check(profile: ProjectProfile, options?: EnvConsistencyOptions): Promise<EnvConsistencyReport>;
}
