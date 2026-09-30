/**
 * 文件系统级垃圾检测器（垃圾清理域自有能力，代码实现）
 *
 * 覆盖：构建产物目录、系统残留 / 临时 / 备份文件、空文件。
 * 与 SOP 规则的分工：
 *   · 本检测器 —— 文件系统事实（是否存在、多大），无需规则驱动的模式判定，故不设 SOP 规则；
 *   · SOP 规则（garbage 域）—— 需要语义/工具判定的项：死代码（ts-prune）、
 *     重复代码（jscpd）、未使用依赖（depcheck），见 item-mapper.ts 的映射表。
 * 二者在 report.ts 合并为同一份 GarbageScanReport。
 *
 * 迁自 @zh/security/garbage-scanner.ts（T5）：垃圾 ≠ 安全，安全中心不再产出垃圾清单。
 * 目录遍历骨架与三类产项已收敛到 @zh/shared 的 scanGarbageDir；本文件只保留本域
 * 特有的忽略口径（IGNORE_DIRS / MAX_DEPTH / REGENERABLE_DIRS）与体积统计口径。
 */
import type { GarbageItem } from '@zh/shared';
import { dirSizeOf, scanGarbageDir } from '@zh/shared';
import { isJunkFileName, REGENERABLE_DIRS } from './junk-rules';

/**
 * 扫描一律跳过的目录。
 *
 * `.zhshield` 是本域自身状态目录（含用户可恢复的回收站）：纳入扫描会让清理
 * 把自己的回收站重新计成垃圾，点一次清理数字反而上升（回归锁 clean-must-not-inflate-count）。
 * `.turbo` 是机器缓存、永非用户源码：进本集合后任意层级都不展开，其 turbo-build.log
 * 不再被计成垃圾（回归锁 build-must-not-grow-count）。根级 `.turbo` 的清理能力
 * 由 REGENERABLE_DIRS 在 depth===0 处保留。
 */
const IGNORE_DIRS = new Set(['node_modules', '.git', '.zhshield', '.turbo']);

const MAX_DEPTH = 14;

/** 扫描文件系统级垃圾：构建产物 / 垃圾文件 / 空文件 */
export async function detectFsGarbage(projectPath: string): Promise<GarbageItem[]> {
  return scanGarbageDir(projectPath, {
    ignoreDirs: IGNORE_DIRS,
    buildArtifactDirs: REGENERABLE_DIRS,
    isJunkFileName,
    measureDirSize: dirSize,
  });
}

/**
 * 递归统计目录体积。
 *
 * 与遍历保持同一条忽略口径（见 IGNORE_DIRS）：
 *   · 构建产物里嵌入 node_modules 时，递归进去既慢又可能踩符号链接环；
 *   · 代价是这类嵌套 node_modules 不计入体积 —— 属**少报**（承诺可释放空间偏小），
 *     不会出现"承诺得多、实际释放得少"的虚报。
 */
function dirSize(dir: string): number {
  return dirSizeOf(dir, { ignoreNames: IGNORE_DIRS, maxDepth: MAX_DEPTH });
}
