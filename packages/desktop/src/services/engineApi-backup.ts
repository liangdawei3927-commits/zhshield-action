/**
 * 引擎 API 分片 — Backup 备份系统：执行备份、记录与配置读写、进度订阅与授权
 *
 * HTTP 模式部分能力直连服务端接口；IPC 桥接缺失时返回空结果 / 退订函数兜底。
 */
import { t } from '@zh/i18n';
import type {
  BackupRecordData,
  BackupResultData,
  BackupConfigData,
  BackupProgressData,
} from '../types/electron';
import {
  runBackupViaHttp,
  getBackupRecordsViaHttp,
  getBackupRecordViaHttp,
  deleteBackupRecordViaHttp,
  getBackupConfigViaHttp,
  saveBackupConfigViaHttp,
} from './serverApi';
import { isHttpMode, getAPI } from './engineApi-transport';

// ─── Backup 备份系统 ─────────────────────────────────────

export async function runBackup(projectPath: string, trigger?: string): Promise<BackupResultData> {
  if (isHttpMode()) return runBackupViaHttp(projectPath, trigger) as Promise<BackupResultData>;
  const api = getAPI();
  if (!api?.backup) {
    return {
      projectId: 'default',
      projectName: t('engine.unknownProject'),
      trigger: trigger ?? 'manual',
      overallStatus: 'failed',
      timestamp: new Date().toISOString(),
      duration: 0,
      error: t('engine.backupModuleUnavailable'),
      results: [],
    };
  }
  return api.backup.executeBackup(projectPath, trigger);
}

export async function getBackupRecords(projectId?: string): Promise<BackupRecordData[]> {
  if (isHttpMode()) return getBackupRecordsViaHttp(projectId) as Promise<BackupRecordData[]>;
  const api = getAPI();
  if (!api?.backup) return [];
  return api.backup.getRecords(projectId);
}

/** 单条备份记录查询；UI 未接入，故 ts-prune 报为未使用。 */
export async function getBackupRecord(recordId: string): Promise<BackupRecordData | null> {
  if (isHttpMode()) return getBackupRecordViaHttp(recordId) as Promise<BackupRecordData | null>;
  const api = getAPI();
  if (!api?.backup) return null;
  return api.backup.getRecord(recordId);
}

export async function deleteBackupRecord(recordId: string): Promise<boolean> {
  if (isHttpMode()) return deleteBackupRecordViaHttp(recordId);
  const api = getAPI();
  if (!api?.backup) return false;
  return api.backup.deleteRecord(recordId);
}

export async function getBackupConfig(projectPath: string): Promise<BackupConfigData | null> {
  if (isHttpMode()) return getBackupConfigViaHttp(projectPath) as Promise<BackupConfigData>;
  const api = getAPI();
  if (!api?.backup) return null;
  return api.backup.getConfig(projectPath);
}

export async function saveBackupConfig(
  projectPath: string,
  config: BackupConfigData,
): Promise<void> {
  if (isHttpMode()) return saveBackupConfigViaHttp(projectPath, config);
  const api = getAPI();
  if (!api?.backup) return;
  return api.backup.saveConfig(projectPath, config);
}

export async function authorizeGitHub(): Promise<boolean> {
  if (isHttpMode()) return false;
  const api = getAPI();
  if (!api?.backup) return false;
  return api.backup.authorizeGitHub();
}

/** 订阅备份进度推送；无 Electron API 时返回空退订函数 */
export function onBackupProgress(callback: (payload: BackupProgressData) => void): () => void {
  const api = getAPI();
  return api?.backup?.onProgress?.(callback) ?? (() => {});
}

/** 订阅备份完成推送。`backup:completed` 事件已在 preload 桥接，UI 未订阅。 */
export function onBackupCompleted(callback: (payload: unknown) => void): () => void {
  const api = getAPI();
  return api?.backup?.onCompleted?.(callback) ?? (() => {});
}

/** 订阅备份失败推送。`backup:failed` 事件已在 preload 桥接，UI 未订阅。 */
export function onBackupFailed(callback: (payload: unknown) => void): () => void {
  const api = getAPI();
  return api?.backup?.onFailed?.(callback) ?? (() => {});
}

/** 订阅备份记录更新推送（定时备份在后台完成时通知刷新列表） */
export function onBackupRecordsUpdated(callback: (payload: unknown) => void): () => void {
  const api = getAPI();
  return api?.backup?.onRecordsUpdated?.(callback) ?? (() => {});
}

export async function openBackupFolder(
  projectPath: string,
  folderPath: string,
): Promise<boolean> {
  const api = getAPI();
  if (!api?.backup) return false;
  return api.backup.openFolder(projectPath, folderPath);
}
