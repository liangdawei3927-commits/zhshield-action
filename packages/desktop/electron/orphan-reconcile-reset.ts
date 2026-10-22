import * as path from 'node:path';
import * as fs from 'node:fs';
import { listSoftDeletedProjectIds, purgeExpiredSoftDeleted } from '@zh/db';
import { saveCapabilityRefs, loadCapabilityRefs } from './capability-refs';
import { sopCache, wisdomBrainSync } from './ipc-context';
import {
  PROFILES_DIR,
  EMPTY_GRACE_MS,
  EMPTY_SINCE_KEY,
  auditLog,
  warn,
} from './orphan-reconcile-shared';
import type { Db } from './orphan-reconcile-shared';
import type { CleanResetReport, OrphanState } from './orphan-reconcile-types';

// ─── 空项目集宽限 + 全局重置 ───

/** 本地是否存在待清理残留（画像 trash / DB 软删行 / 工具规则 / 能力账本） */
async function hasLocalResiduals(db: Db): Promise<boolean> {
  if (await hasTrashResiduals()) return true;
  if (await hasCapabilityRefsResiduals()) return true;
  if (hasSoftDeletedRows(db)) return true;
  return await hasToolRuleResiduals();
}

async function hasTrashResiduals(): Promise<boolean> {
  try {
    const entries = await fs.promises.readdir(path.join(PROFILES_DIR, 'trash'));
    return entries.length > 0;
  } catch {
    // trash 不存在 → 无画像残留
    return false;
  }
}

async function hasCapabilityRefsResiduals(): Promise<boolean> {
  try {
    const refs = await loadCapabilityRefs();
    return Object.keys(refs.capabilities).length > 0;
  } catch {
    // 账本不可读 → 视为无残留
    return false;
  }
}

function hasSoftDeletedRows(db: Db): boolean {
  try {
    return listSoftDeletedProjectIds(db).length > 0;
  } catch {
    // DB 不可查 → 视为无残留
    return false;
  }
}

async function hasToolRuleResiduals(): Promise<boolean> {
  try {
    const toolIds = wisdomBrainSync.getRuleSync().getUnfilteredToolIds();
    for (const toolId of toolIds) {
      try {
        await fs.promises.stat(wisdomBrainSync.getRuleSync().getRuleDir(toolId));
        return true;
      } catch {
        // 该工具无规则目录 → 继续
      }
    }
  } catch {
    // 工具同步未初始化 → 视为无残留
  }
  return false;
}

/** 全局重置：彻底清除全部本地残留（画像 trash / SOP 缓存 / 工具规则 / 能力账本 / DB 软删行） */
async function resetToCleanState(db: Db, emptySince: number): Promise<CleanResetReport> {
  const profilesTrashCleared = await clearProfilesTrash();
  const sopCacheCleared = await clearSopCache();
  const removedTools = await removeAllToolRules();
  const capabilityRefsCleared = await clearCapabilityRefs();
  const purged = purgeAllSoftDeleted(db);
  await auditLog
    .logOrphanCleanup({
      action: 'clean_reset',
      emptySince,
      profilesTrashCleared,
      sopCacheCleared,
      removedTools,
      capabilityRefsCleared,
      purged,
    })
    .catch(() => {});
  return {
    emptySince,
    profilesTrashCleared,
    sopCacheCleared,
    removedTools,
    capabilityRefsCleared,
    purged,
  };
}

async function clearProfilesTrash(): Promise<boolean> {
  try {
    await fs.promises.rm(path.join(PROFILES_DIR, 'trash'), { recursive: true, force: true });
    return true;
  } catch (err) {
    warn('[orphan-reconcile] 全局重置：清理画像 trash 失败:', err);
    return false;
  }
}

async function clearSopCache(): Promise<boolean> {
  try {
    await sopCache.clearCache();
    return true;
  } catch (err) {
    warn('[orphan-reconcile] 全局重置：清空 SOP 缓存失败:', err);
    return false;
  }
}

async function removeAllToolRules(): Promise<string[]> {
  const removedTools: string[] = [];
  try {
    const toolIds = wisdomBrainSync.getRuleSync().getUnfilteredToolIds();
    for (const toolId of toolIds) {
      try {
        await wisdomBrainSync.getRuleSync().removeRules(toolId);
        removedTools.push(toolId);
      } catch (err) {
        warn(`[orphan-reconcile] 全局重置：删除工具规则 ${toolId} 失败:`, err);
      }
    }
  } catch (err) {
    warn('[orphan-reconcile] 全局重置：工具规则清除失败:', err);
  }
  return removedTools;
}

async function clearCapabilityRefs(): Promise<boolean> {
  try {
    await saveCapabilityRefs({ schemaVersion: 1, capabilities: {} });
    return true;
  } catch (err) {
    warn('[orphan-reconcile] 全局重置：清空能力账本失败:', err);
    return false;
  }
}

function purgeAllSoftDeleted(db: Db): { table: string; deleted: number }[] {
  try {
    return purgeExpiredSoftDeleted(db, 0);
  } catch (err) {
    warn('[orphan-reconcile] 全局重置：DB 软删行强清失败:', err);
    return [];
  }
}

/**
 * 空项目集宽限逻辑：空集开始记录 → 7 天到期执行全局重置（项目重加则取消宽限）。
 * 置于画像扫描/TTL 之后：重置为最后一个写操作，避免扫描新移入的残留被跳过。
 */
async function handleEmptyGrace(
  db: Db,
  activeProjectPaths: string[],
  state: OrphanState,
): Promise<CleanResetReport | undefined> {
  if (activeProjectPaths.length > 0) {
    delete state[EMPTY_SINCE_KEY];
    return undefined;
  }
  const existing = state[EMPTY_SINCE_KEY];
  if (typeof existing !== 'number') {
    if (await hasLocalResiduals(db)) {
      state[EMPTY_SINCE_KEY] = Date.now();
      console.warn('[orphan-reconcile] 项目集为空且存在残留 → 开始 7 天宽限记录');
    }
    return undefined;
  }
  if (Date.now() - existing < EMPTY_GRACE_MS) return undefined;
  const report = await resetToCleanState(db, existing);
  delete state[EMPTY_SINCE_KEY];
  return report;
}

// ─── 对外导出 ───

export { handleEmptyGrace };
