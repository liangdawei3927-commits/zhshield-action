/**
 * 智汇大脑同步 + SOP 规则同步 IPC（ipc/sync.ts）
 *
 * sync:*：工具规则下发 / 经验回写（智汇大脑协同 8.1 / 8.2）
 * sop:*：SOP 规则缓存查询 / 手动同步 / 紧急更新
 */

import { ipcMain } from 'electron';

import type { ExperienceRecord, GovernanceDomain, SignedSopPackage, ToolRuleSyncResult } from '@zh/kernel';
import { SopSigner } from '@zh/kernel';
import { resolveSopPublicKey, sopCache, sopRegistry, wisdomBrainSync } from '../ipc-context';

export function registerSyncIpc(): void {
  registerToolRuleSync();
  registerExperienceSync();
  registerSopSync();
}

/** 工具规则同步（智汇大脑协同 8.1） */
function registerToolRuleSync(): void {
  ipcMain.handle('sync:rules', async (): Promise<ToolRuleSyncResult[]> => {
    return wisdomBrainSync.syncAllRules();
  });

  ipcMain.handle('sync:rulesStatus', async (): Promise<Array<{ toolId: string; localVersion: string | null; stale: boolean }>> => {
    const rs = wisdomBrainSync.getRuleSync();
    const tools = rs.getConfiguredToolIds() as Array<'semgrep' | 'trivy' | 'eslint' | 'dep-cruiser'>;
    return tools.map((tid) => ({
      toolId: tid,
      localVersion: rs.getLocalVersion(tid)?.version ?? null,
      stale: rs.isStale(tid),
    }));
  });

  ipcMain.handle('sync:emergencyUpdate', async (_event, toolId: string): Promise<ToolRuleSyncResult> => {
    return wisdomBrainSync.syncToolRules(toolId as 'semgrep' | 'trivy' | 'eslint' | 'dep-cruiser');
  });
}

/** 经验回写（智汇大脑协同 8.2） */
function registerExperienceSync(): void {
  ipcMain.handle('sync:submitExperience', async (_event, records: ExperienceRecord[]): Promise<{ sent: number; queued: number; failed: number }> => {
    const result = await wisdomBrainSync.syncExperienceBatch(records);
    return result;
  });

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
function registerSopSyncActions(): void {
  ipcMain.handle('sop:syncNow', async () => {
    return sopCache.syncFromCloud();
  });

  ipcMain.handle('sop:emergencyUpdate', async (_event, pkgJson: string) => {
    let pkg: SignedSopPackage;
    try {
      pkg = JSON.parse(pkgJson) as SignedSopPackage;
    } catch {
      return { success: false, reason: 'invalid_payload' };
    }

    const publicKey = await resolveSopPublicKey();
    if (!publicKey) {
      return { success: false, reason: 'no_public_key' };
    }

    const verify = SopSigner.verifyPackageWithKey(pkg, publicKey);
    if (!verify.valid) {
      return { success: false, reason: verify.reason ?? 'verification_failed' };
    }

    await sopCache.emergencyUpdate(pkg.rules);
    return { success: true };
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
