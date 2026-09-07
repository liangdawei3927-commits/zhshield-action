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
  getCachedProfileProjectPath,
  getDefaultOrgId,
  cloudResolveTools,
  type ScopeProfileLike,
} from '../ipc-context';
import { isToolInScope, isToolLanguagesMatch } from '@zh/shared';
import {
  claimToolRefs,
  deriveProjectId,
  loadCapabilityRefs,
  markReclaimed,
  saveCapabilityRefs,
  splitResolvedTools,
  type LanguagesByTool,
} from '../capability-refs';
import { reconcileRulesWithCloud, type ResolveRulesOutcome } from './resolve-reconcile';

export type { ResolveRulesOutcome };

/** 工具规则按画像同步（sync:rules IPC 与画像漂移触发共用） */
export async function syncToolRulesForProfile(): Promise<ToolRuleSyncResult[]> {
  const feature = getCachedProfile() ?? undefined;
  const ruleSync = wisdomBrainSync.getRuleSync();
  // R3-b：云端下发 languages 元数据（toolId → languages），claim 时写入账本
  let languagesByTool: LanguagesByTool = {};
  try {
    const orgId = await getDefaultOrgId();
    if (orgId) {
      const remoteTools = await cloudResolveTools(orgId, feature as ScopeProfileLike | undefined);
      const split = splitResolvedTools(remoteTools);
      ruleSync.setRemoteToolIds(split.toolIds);
      languagesByTool = split.languagesByTool;
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
  // R2 领取记账（06 §3.3「领取」+ §3.4 ①）：在 syncAllRules 之前记账，
  // 使能力被项目占用（下次同步续期）；唤醒必须先于 syncAllRules，
  // 否则 reclaiming 工具已被运行层过滤踢出清单、永远不会被重新同步。
  const projectPath = getCachedProfileProjectPath();
  if (projectPath) {
    // 领取用「未过滤」清单（含 reclaiming）：唤醒必须先于运行层过滤，
    // 否则 7 天窗口内重加同栈项目时 reclaiming 能力永远进不了 claim 列表
    // （getConfiguredToolIds 已剔 reclaiming，不能用于领取）。
    const inScope = wisdomBrainSync
      .getRuleSync()
      .getUnfilteredToolIds()
      .filter((toolId) => isToolInScope(toolId, feature));
    // R3c：claim 前按 languagesByTool + 项目主语言投影，语言不匹配的能力不进入 refs
    const claimable = inScope.filter((toolId) =>
      isToolLanguagesMatch(languagesByTool[toolId], { language: feature?.language }),
    );
    const refs = await loadCapabilityRefs();
    await saveCapabilityRefs(
      claimToolRefs(refs, deriveProjectId(projectPath), claimable, languagesByTool),
    );
  }
  const results = await wisdomBrainSync.syncAllRules(feature);
  // R3-a 到期物理删除对账（06 §4.3 + §2.4 触发链）：kernel 扫描并物理删除过期
  // reclaiming 工具，返回本次删除列表 → 账本标记 reclaimed 终态。
  // best-effort：扫描/标记失败绝不阻断同步响应。
  try {
    const deleted = await wisdomBrainSync.scanAndRemoveExpired();
    if (deleted.length > 0) {
      await saveCapabilityRefs(markReclaimed(await loadCapabilityRefs(), deleted));
    }
  } catch (err) {
    console.warn(
      '[sync:R3] 到期物理删除对账失败（best-effort 跳过）:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return results;
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
