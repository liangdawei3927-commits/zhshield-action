/**
 * 一键备份系统 — 统一导出
 */
export { BackupOrchestrator } from './orchestrator';
export type { BackupOrchestratorOptions } from './orchestrator';

export { BackupConfigManager } from './config';
export type { BackupGlobalConfig } from './config';
export { DEFAULT_GLOBAL_CONFIG } from './config';

export { GitHubBackup } from './github-backup';
export type { TokenStore } from './github-backup';
export { LocalBackup } from './local-backup';
export type { LocalBackupFileEntry, LocalBackupManifest } from './local-backup';

export { BackupScheduler } from './scheduler';

export { BACKUP_EVENTS } from './events';
export type {
  BackupRequestPayload,
  BackupStartedPayload,
  BackupProgressPayload,
  BackupCompletedPayload,
  BackupFailedPayload,
  BackupConfigUpdatedPayload,
} from './events';

export type {
  BackupConfig,
  GitHubBackupConfig,
  LocalBackupConfig,
  BackupScheduleConfig,
  BackupResult,
  BackupSubResult,
  GitHubBackupSubResult,
  LocalBackupSubResult,
  BackupRecord,
  BackupType,
  BackupStatus,
  BackupTrigger,
  BackupTypeTag,
  BackupRequestPayload as BackupRequest,
  BackupStartedPayload as BackupStarted,
  BackupProgressPayload as BackupProgress,
  BackupCompletedPayload as BackupCompleted,
  BackupFailedPayload as BackupFailed,
  BackupConfigUpdatedPayload as BackupConfigUpdated,
} from './types';

export { defaultBackupConfig, DEFAULT_EXCLUDE_PATTERNS } from './types';
