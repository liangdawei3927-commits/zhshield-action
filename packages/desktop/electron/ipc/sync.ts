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
  cloudResolveRules,
  type ScopeProfileLike,
} from '../ipc-context';

/** /resolve/rules 云端生效规则解析结果（T1 规则差量；失败降级不阻断同步） */
export interface ResolveRulesOutcome {
  ok: boolean;
  reason?: 'no_org' | 'cloud_error';
  total: number;
  changed: string[];
}

/** 云端规则差量解析：按当前画像返回生效清单 + changed 差量（云端不可达时降级本地全量） */
async function resolveRulesHandler(): Promise<ResolveRulesOutcome> {
  const feature = getCachedProfile() ?? undefined;
  try {
    const orgId = await getDefaultOrgId();
    if (!orgId) {
      return { ok: false, reason: 'no_org', total: 0, changed: [] };
    }
    const res = await cloudResolveRules(orgId, feature as ScopeProfileLike | undefined);
    console.log(
      `[cloud:T1] /resolve/rules 生效规则 ${res.rules.length} 条，本次变更 ${res.changed.length} 条`,
    );
    return { ok: true, total: res.rules.length, changed: res.changed };
  } catch (err) {
    console.warn(
      '[cloud:T1] /resolve/rules 失败，降级本地全量:',
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: 'cloud_error', total: 0, changed: [] };
  }
}

export function registerSyncIpc(): void {
  registerToolRuleSync();
  registerExperienceSync();
  registerSopSync();
}

/** 工具规则同步（智汇大脑协同 8.1） */
function registerToolRuleSync(): void {
  ipcMain.handle('sync:rules', async (): Promise<ToolRuleSyncResult[]> => {
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
  });

  ipcMain.handle('sync:resolveRules', () => resolveRulesHandler());

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
    return sopCache.syncFromCloud();
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
