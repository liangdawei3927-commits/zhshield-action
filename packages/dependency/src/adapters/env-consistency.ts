/**
 * 环境一致性检查器（env-consistency.ts）
 *
 * 纯离线静态比对项目声明的运行环境与实际配置，输出 EnvConsistencyReport。
 * 不联网、不执行安装命令；解析失败按缺失处理，绝不抛异常。
 *
 * 检查四类环境偏差：
 * - lockfile-drift：package.json 声明范围 vs 锁文件解析版本（不满足范围 → error）
 * - runtime-version：.nvmrc / .node-version / engines.node / .tool-versions 相互矛盾（矛盾 → error，单源 → info）
 * - env-file-diff：.env.example 声明键 vs .env 实际键（缺键 → warning，多余 → info）
 * - ci-vs-local：.github/workflows/*.yml 中 Node / 包管理器版本 vs 本地清单（不一致 → warning，无 CI → 不产出）
 *
 * 本文件为对外中枢：类型定义、版本/锁文件/运行时检查、环境文件与 CI 检查
 * 分别拆分至同目录 env-consistency-types.ts / env-consistency-versions.ts /
 * env-consistency-env-ci.ts（单向依赖，本文件只向下引用并再导出）。
 */
import { safeJoin, type ProjectProfile } from '@zh/shared';
import { readJsonSafe } from '../lockfile-utils';
import type {
  EnvConsistencyChecker,
  EnvConsistencyOptions,
  EnvConsistencyReport,
  EnvEntry,
} from './env-consistency-types';
import { checkLockfileDrift, checkRuntimeVersion } from './env-consistency-versions';
import { checkCiVsLocal, checkEnvFileDiff } from './env-consistency-env-ci';

// 项目画像类型统一由 @zh/shared 定义（跨包单一事实源）；此处重新导出以保持
// @zh/dependency 既有公开 API（如 @zh/inspect 从本包 import ProjectProfile）。
export type { ProjectLanguage, PackageManager, ProjectProfile } from '@zh/shared';

// 公开类型拆分至 env-consistency-types.ts，此处按原样再导出。
export type {
  EnvConsistencyChecker,
  EnvConsistencyOptions,
  EnvConsistencyReport,
  EnvEntry,
};

/**
 * 环境一致性检查器实现。
 *
 * 纯离线静态分析：只读清单 / 锁文件 / 环境文件 / CI 配置，
 * 任何文件缺失或解析失败都跳过对应检查类别，绝不抛异常。
 */
export class EnvConsistencyCheckerImpl implements EnvConsistencyChecker {
  /** 执行环境一致性检查（离线静态，永不抛异常） */
  async check(
    profile: ProjectProfile,
    options?: EnvConsistencyOptions,
  ): Promise<EnvConsistencyReport> {
    const projectRoot = options?.projectRoot ?? profile.projectPath;

    const pkgJson = readJsonSafe(safeJoin(projectRoot, 'package.json'));
    const entries: EnvEntry[] = [
      ...checkLockfileDrift(projectRoot, pkgJson),
      ...checkRuntimeVersion(projectRoot, pkgJson),
      ...checkEnvFileDiff(projectRoot),
      ...checkCiVsLocal(projectRoot, pkgJson, profile),
    ];
    return { entries };
  }
}
