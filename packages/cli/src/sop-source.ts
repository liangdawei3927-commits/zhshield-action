/**
 * CLI 侧的云端 SOP 规则缓存入口。
 *
 * 定位本体已下沉到 `@zh/kernel`（`sop/cache/sop-cache-locator`），本文件只做两件事：
 *   ① 把它再导出，保证既有导入方（含全部单测）无需改动；
 *   ② 承载 CLI 专有的两件事 —— 新鲜度展示阈值（`STALE_CACHE_DAYS` / `formatAge`）
 *      与「`sop sync` 往哪写」（`resolveSopWriteDir`）。
 *
 * 为什么必须下沉（2026-10-30）：本地检查脚本（zhcheck）与 CLI 要回答同一个问题
 * 「云端规则在哪、能不能用」。各写一份会各自漂移，最坏表现是同一份代码在
 * pre-commit 与 CI 上跑出两套门禁结论、且两边都不报错 —— 而门禁只在云端下发，
 * 定位判错即「整段失声」。
 */

import {
  resolveSopCacheDir,
  resolveDesktopCacheDir,
  resolveCliCacheDir,
  readCacheFreshness,
  currentSopCacheEnv,
} from '@zh/kernel';
import type { SopCacheResolution, SopCacheEnv, CacheFreshness } from '@zh/kernel';
export type { SopCacheResolution, SopCacheEnv, CacheFreshness };
export {
  resolveSopCacheDir,
  resolveDesktopCacheDir,
  resolveCliCacheDir,
  readCacheFreshness,
  currentSopCacheEnv,
};

/** 超过这个天数就提示"规则可能已过期"（云大脑按日同步设计） */
export const STALE_CACHE_DAYS = 7;

/**
 * 解析**写入**目录：`sop sync` 把规则放哪儿。
 *
 * 与读路径分开是必要的：读要求 `modules/` 已存在（否则说明从没同步过），
 * 而写恰恰要在它不存在时创建。显式 `ZH_SOP_CACHE_DIR` 仍然生效 —— 用户指定了位置，
 * 同步结果就必须落在那里，否则「同步成功但读的是别处」无法解释。
 */
export function resolveSopWriteDir(input: SopCacheEnv): { dir: string; origin: string } {
  const explicit = input.env.ZH_SOP_CACHE_DIR?.trim();
  if (explicit) return { dir: explicit, origin: '环境变量 ZH_SOP_CACHE_DIR' };
  return { dir: resolveCliCacheDir(input), origin: 'CLI 自有缓存' };
}

/** 把毫秒差写成「N 天 / N 小时 / N 分钟前」 */
export function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
