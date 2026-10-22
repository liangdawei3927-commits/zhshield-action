/**
 * 密钥全生命周期处理器（ipc/engines-secrets.ts）
 *
 * engine:runSecrets / secretRotating / secretVerify / secretDismiss：
 * 直连主进程，不注册 TaskManager 任务类型，状态落盘 .zhshield/secrets-state.json。
 * 由 engines.ts 引用，依赖方向单向：engines.ts → 本文件（本文件不得 import engines.ts）。
 */

import path from 'node:path';
import { t } from '@zh/i18n';
import { SecretLifecycleManager, FileSecretStore } from '@zh/security';
import { updateDashboardState } from './dashboard-state';
import type { SecretReportData } from '../../src/types/electron';

/** 各项目已实例化的密钥生命周期管理器（key = projectPath，状态变更按 secretId 反查项目） */
const secretManagers = new Map<
  string,
  { manager: SecretLifecycleManager; store: FileSecretStore }
>();

/** 密钥扫描失败时的空报告（error 携带失败原因，不 throw） */
function emptySecretsReport(error: string): SecretReportData {
  return {
    findings: [],
    summary: { total: 0, critical: 0, active: 0, historyFound: 0 },
    lastScannedCommit: '',
    error,
  };
}

/**
 * 密钥全生命周期扫描（engine:runSecrets）：直连主进程，不注册 TaskManager 任务类型。
 * 状态落盘 .zhshield/secrets-state.json（FileSecretStore 自建目录），
 * 实例按 projectPath 缓存供 markRotating / verifyRotated / dismiss 反查。
 */
export async function runSecretsHandler(projectPath: string): Promise<SecretReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const store = new FileSecretStore(path.join(projectPath, '.zhshield', 'secrets-state.json'));
    const manager = new SecretLifecycleManager(undefined, store);
    secretManagers.set(projectPath, { manager, store });
    const report = await manager.scan(projectPath, { history: true });
    // P1b: 补写 dashboard-state secrets 域（active 未处理数 + lastRunAt）
    await updateDashboardState(projectPath, {
      secrets: { activeCount: report.summary.active, lastRunAt: new Date().toISOString() },
    });
    return { ...report, error: null };
  } catch (err) {
    console.error('[engine:runSecrets] Error:', err);
    return emptySecretsReport(err instanceof Error ? err.message : String(err));
  }
}

/** 按 secretId 反查持有该密钥状态的项目管理器；未找到返回 undefined（对应渲染层静默成功/返回 false） */
async function findSecretManager(
  secretId: string,
): Promise<{ manager: SecretLifecycleManager } | undefined> {
  for (const { manager, store } of secretManagers.values()) {
    const state = await store.load();
    if (state.secrets[secretId]) return { manager };
  }
  return undefined;
}

/** 标记密钥进入轮换（engine:secretRotating）；未找到对应项目时静默成功 */
export async function markSecretRotatingHandler(secretId: string): Promise<void> {
  try {
    if (!secretId || typeof secretId !== 'string') return;
    const entry = await findSecretManager(secretId);
    if (!entry) return;
    await entry.manager.markRotating(secretId);
  } catch (err) {
    console.error('[engine:secretRotating] Error:', err);
  }
}

/** 复核密钥是否已轮换（engine:secretVerify）；未找到对应项目时返回 false */
export async function verifySecretRotatedHandler(secretId: string): Promise<boolean> {
  try {
    if (!secretId || typeof secretId !== 'string') return false;
    const entry = await findSecretManager(secretId);
    if (!entry) return false;
    return entry.manager.verifyRotated(secretId);
  } catch (err) {
    console.error('[engine:secretVerify] Error:', err);
    return false;
  }
}

/** 驳回密钥告警（engine:secretDismiss）；未找到对应项目时静默成功 */
export async function dismissSecretHandler(secretId: string, reason: string): Promise<void> {
  try {
    if (!secretId || typeof secretId !== 'string') return;
    const entry = await findSecretManager(secretId);
    if (!entry) return;
    await entry.manager.dismiss(secretId, reason);
  } catch (err) {
    console.error('[engine:secretDismiss] Error:', err);
  }
}
