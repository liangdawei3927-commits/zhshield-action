/**
 * 引擎 API 分片 — Secrets 密钥全生命周期引擎：扫描、轮换与忽略
 *
 * 走 Electron IPC，引擎不可用时返回空报告 / 静默降级。
 */
import { t } from '@zh/i18n';
import type { SecretReportData } from '../types/electron';
import { getAPI } from './engineApi-transport';

// ─── Secrets 密钥全生命周期引擎 ────────────────────────────

export async function runSecrets(projectPath: string): Promise<SecretReportData> {
  const api = getAPI();
  if (!api?.engine) {
    return {
      findings: [],
      summary: { total: 0, critical: 0, active: 0, historyFound: 0 },
      lastScannedCommit: '',
      error: t('engine.engineUnavailable'),
    };
  }
  return api.engine.runSecrets(projectPath);
}

export async function markSecretRotating(secretId: string): Promise<void> {
  const api = getAPI();
  if (!api?.engine) return;
  return api.engine.markSecretRotating(secretId);
}

export async function verifySecretRotated(secretId: string): Promise<boolean> {
  const api = getAPI();
  if (!api?.engine) return false;
  return api.engine.verifySecretRotated(secretId);
}

export async function dismissSecret(secretId: string, reason: string): Promise<void> {
  const api = getAPI();
  if (!api?.engine) return;
  return api.engine.dismissSecret(secretId, reason);
}
