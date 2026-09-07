/**
 * 项目生命周期编排（project-lifecycle.ts）
 *
 * 删项目完整归还链（06 §3.4 ②-⑤）：画像 / DB / 内存 / 云端，
 * 不碰规则缓存与 experiences。整链以 projectPath 为准。
 * 每步结果以 ProjectRemovalStep[] 返回，供 IPC 审计与错误摘要使用。
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

/** 删项目归还链单步结果（供 IPC 审计与错误摘要使用） */
export interface ProjectRemovalStep {
  step: string;
  status: 'ok' | 'failed';
  error?: string;
}

/** 将任意错误归一为脱敏字符串（不含 token；路径类信息可保留，与现有日志风格一致） */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 删项目完整归还链（06 §3.4 ②-⑤）：
 *   1. 画像文件删除（~/.zhshield/profiles/）
 *   2. DB 软删（softDeleteProjectData；无持久化模式降级仅 warn）
 *   3. 内存缓存归还（仅当缓存归属该项目时清空）
 *   4. 云端画像注销（内部已降级不抛）
 *   5. 能力引用归还（refs 空的能力 → reclaiming + since）
 * 不碰规则缓存与 experiences（06 §2.4）。
 *
 * 每步独立 try/catch 收集结果，任一步失败不阻断后续步骤；
 * 返回每步成败，供调用方审计与汇总错误。
 */
export async function cleanupProjectAfterRemoval(
  projectPath: string,
): Promise<ProjectRemovalStep[]> {
  const steps: ProjectRemovalStep[] = [];

  // 1. 画像文件删除
  try {
    createProfileStore().delete(projectPath);
    steps.push({ step: 'profile-delete', status: 'ok' });
  } catch (err) {
    console.warn('[project-lifecycle] 画像删除失败,降级跳过:', errMsg(err));
    steps.push({ step: 'profile-delete', status: 'failed', error: errMsg(err) });
  }

  // 2. DB 软删（无持久化模式 getDb 抛错 → 降级仅 warn，不阻断）
  try {
    softDeleteProjectData(getDb(), projectPath);
    steps.push({ step: 'db-soft-delete', status: 'ok' });
  } catch (err) {
    console.warn('[project-lifecycle] DB 软删失败，降级跳过:', errMsg(err));
    steps.push({ step: 'db-soft-delete', status: 'failed', error: errMsg(err) });
  }

  // 3. 内存缓存归还（仅当缓存归属该项目时清空，宁缺毋滥）
  try {
    if (getCachedProfileProjectPath() === projectPath) {
      // 第二参传 null 才会同时清空归属 path（ipc-context 语义：不传则保持 path 不变）
      setCachedProfile(null, null);
    }
    steps.push({ step: 'memory-release', status: 'ok' });
  } catch (err) {
    console.warn('[project-lifecycle] 内存缓存归还失败,降级跳过:', errMsg(err));
    steps.push({ step: 'memory-release', status: 'failed', error: errMsg(err) });
  }

  // 4. 云端画像注销（内部已降级不抛，仍 try/catch 保险）
  try {
    await unregisterProjectFeaturesFromCloud(projectPath);
    steps.push({ step: 'cloud-unregister', status: 'ok' });
  } catch (err) {
    console.warn('[project-lifecycle] 云端注销失败,降级跳过:', errMsg(err));
    steps.push({ step: 'cloud-unregister', status: 'failed', error: errMsg(err) });
  }

  // 5. 能力引用归还（06 §3.4 ⑥）：refs 空的能力 → reclaiming + since
  try {
    await saveCapabilityRefs(
      releaseProjectRefs(await loadCapabilityRefs(), deriveProjectId(projectPath)),
    );
    steps.push({ step: 'capability-refs-release', status: 'ok' });
  } catch (err) {
    console.warn('[project-lifecycle] 能力引用归还失败,降级跳过:', errMsg(err));
    steps.push({ step: 'capability-refs-release', status: 'failed', error: errMsg(err) });
  }

  return steps;
}
