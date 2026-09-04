/**
 * 智汇大脑同步 + SOP 规则同步 IPC（ipc/sync.ts）
 *
 * sync:*：工具规则下发 / 经验回写（智汇大脑协同 8.1 / 8.2）
 * sop:*：SOP 规则缓存查询 / 手动同步 / 紧急更新
 */

import { ipcMain } from 'electron';

import type {
  ExperienceRecord,
  GovernanceDomain,
  SignedSopPackage,
  ToolId,
  ToolRuleSyncResult,
} from '@zh/kernel';
import { SopSigner } from '@zh/kernel';
import {
  resolveSopPublicKey,
  sopCache,
  sopRegistry,
  wisdomBrainSync,
  getCachedProfile,
  getDefaultOrgId,
  cloudResolveTools,
  type ScopeProfileLike,
} from '../ipc-context';
import { reconcileRulesWithCloud, type ResolveRulesOutcome } from './resolve-reconcile';

export type { ResolveRulesOutcome };

/** 工具规则按画像同步（sync:rules IPC 与画像漂移触发共用） */
export async function syncToolRulesForProfile(): Promise<ToolRuleSyncResult[]> {
  const feature = getCachedProfile() ?? undefined;
  const ruleSync = wisdomBrainSync.getRuleSync();
  try {
    const orgId = await getDefaultOrgId();
    if (orgId) {
      const remoteTools = await cloudResolveTools(orgId, feature as ScopeProfileLike | undefined);
      ruleSync.setRemoteToolIds(remoteTools as ToolId[]);
    } else {
      ruleSync.setRemoteToolIds(null);
    }
  } catch (err) {
    console.warn(
      '[cloud:T1] 云端工具 resolve 失败，降级为本地默认:',
      err instanceof Error ? err.message : String(err),
    );
    ruleSync.setRemoteToolIds(null);
  }
  return wisdomBrainSync.syncAllRules(feature);
}

export function registerSyncIpc(): void {
  registerToolRuleSync();
  registerExperienceSync();
  registerSopSync();
}

/** 工具规则同步（智汇大脑协同 8.1） */
function registerToolRuleSync(): void {
  ipcMain.handle('sync:rules', () => syncToolRulesForProfile());

  ipcMain.handle('sync:resolveRules', () => reconcileRulesWithCloud());

  ipcMain.handle(
    'sync:rulesStatus',
    async (): Promise<Array<{ toolId: string; localVersion: string | null; stale: boolean }>> => {
      const rs = wisdomBrainSync.getRuleSync();
      const tools = rs.getConfiguredToolIds() as ToolId[];
      return tools.map((tid) => ({
        toolId: tid,
        localVersion: rs.getLocalVersion(tid)?.version ?? null,
        stale: rs.isStale(tid),
      }));
    },
  );

  ipcMain.handle(
    'sync:emergencyUpdate',
    async (_event, toolId: string): Promise<ToolRuleSyncResult> => {
      return wisdomBrainSync.syncToolRules(toolId as ToolId);
    },
  );
}

/** 经验回写（智汇大脑协同 8.2） */
function registerExperienceSync(): void {
  ipcMain.handle(
    'sync:submitExperience',
    async (
      _event,
      records: ExperienceRecord[],
    ): Promise<{ sent: number; queued: number; failed: number }> => {
      const result = await wisdomBrainSync.syncExperienceBatch(records);
      return result;
    },
  );

  ipcMain.handle('sync:queueStatus', async (): Promise<{ queueLength: number }> => {
    return { queueLength: wisdomBrainSync.getExperienceReporter().getQueueLength() };
  });
}

/** SOP 版本与同步健康状态查询 IPC */
function registerSopVersionQuery(): void {
  ipcMain.handle('sop:getVersion', async () => {
    const version = await sopCache.getLocalVersion();
    return version ?? { version: '0.0.0', publishedAt: new Date().toISOString() };
  });

  ipcMain.handle('sop:getSyncHealth', async () => {
    return {
      level: sopCache.getSyncHealthLevel(),
      stale: sopCache.isStale(),
      lastSync: (await sopCache.getLocalVersion())?.publishedAt ?? null,
    };
  });
}

/** SOP 同步动作 IPC：手动同步与紧急更新 */
async function verifySopPackage(
  pkgJson: string,
): Promise<{ pkg?: SignedSopPackage; reason?: string }> {
  let pkg: SignedSopPackage;
  try {
    pkg = JSON.parse(pkgJson) as SignedSopPackage;
  } catch {
    return { reason: 'invalid_payload' };
  }

  const publicKey = await resolveSopPublicKey();
  if (!publicKey) {
    return { reason: 'no_public_key' };
  }

  const verify = SopSigner.verifyPackageWithPublicKey(pkg, publicKey);
  if (!verify.valid) {
    return { reason: verify.reason ?? 'verification_failed' };
  }

  return { pkg };
}

async function handleSopEmergencyUpdate(
  pkgJson: string,
): Promise<{ success: boolean; reason?: string }> {
  const { pkg, reason } = await verifySopPackage(pkgJson);
  if (!pkg) {
    return { success: false, reason };
  }
  await sopCache.emergencyUpdate(pkg.rules);
  return { success: true };
}

function registerSopSyncActions(): void {
  ipcMain.handle('sop:syncNow', async () => {
    const result = await sopCache.syncFromCloud();
    // 同步后顺手做一次云端对账（fire-and-forget，失败不影响返回值）
    void reconcileRulesWithCloud().catch(() => {});
    return result;
  });

  ipcMain.handle('sop:emergencyUpdate', async (_event, pkgJson: string) => {
    return handleSopEmergencyUpdate(pkgJson);
  });
}

/** SOP 规则查询 IPC：统计与规则列表 */
function registerSopRuleQuery(): void {
  ipcMain.handle('sop:getStats', async () => {
    return sopRegistry.getStats();
  });

  ipcMain.handle('sop:checkRules', async (_event, domain?: string) => {
    if (domain) {
      return sopRegistry.getByDomain(domain as GovernanceDomain);
    }
    return sopRegistry.getActive();
  });
}

/** SOP 规则同步 */
function registerSopSync(): void {
  registerSopVersionQuery();
  registerSopSyncActions();
  registerSopRuleQuery();
}
