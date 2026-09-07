/**
 * 项目生命周期编排（project-lifecycle.ts）
 *
 * 删项目完整归还链（06 §3.4 ②-⑤）：画像 / DB / 内存 / 云端，
 * 不碰规则缓存与 experiences。整链以 projectPath 为准。
 */

import { createProfileStore } from '@zh/fingerprint';
import { softDeleteProjectData } from '@zh/db';
import {
  getDb,
  getCachedProfileProjectPath,
  setCachedProfile,
  unregisterProjectFeaturesFromCloud,
} from './ipc-context';
import {
  deriveProjectId,
  loadCapabilityRefs,
  releaseProjectRefs,
  saveCapabilityRefs,
} from './capability-refs';

/**
 * 删项目完整归还链（06 §3.4 ②-⑤）：
 *   1. 画像文件删除（~/.zhshield/profiles/）
 *   2. DB 软删（softDeleteProjectData；无持久化模式降级仅 warn）
 *   3. 内存缓存归还（仅当缓存归属该项目时清空）
 *   4. 云端画像注销（内部已降级不抛）
 * 不碰规则缓存与 experiences（06 §2.4）。
 */
export async function cleanupProjectAfterRemoval(projectPath: string): Promise<void> {
  // 1. 画像文件删除
  createProfileStore().delete(projectPath);

  // 2. DB 软删（无持久化模式 getDb 抛错 → 降级仅 warn，不阻断）
  try {
    softDeleteProjectData(getDb(), projectPath);
  } catch (err) {
    console.warn(
      '[project-lifecycle] DB 软删失败，降级跳过:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // 3. 内存缓存归还（仅当缓存归属该项目时清空，宁缺毋滥）
  if (getCachedProfileProjectPath() === projectPath) {
    // 第二参传 null 才会同时清空归属 path（ipc-context 语义：不传则保持 path 不变）
    setCachedProfile(null, null);
  }

  // 4. 云端画像注销（内部已降级不抛）
  await unregisterProjectFeaturesFromCloud(projectPath);

  // 5. 能力引用归还（06 §3.4 ⑥）：refs 空的能力 → reclaiming + since
  try {
    await saveCapabilityRefs(
      releaseProjectRefs(await loadCapabilityRefs(), deriveProjectId(projectPath)),
    );
  } catch (err) {
    console.warn(
      '[project-lifecycle] 能力引用归还失败,降级跳过:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
