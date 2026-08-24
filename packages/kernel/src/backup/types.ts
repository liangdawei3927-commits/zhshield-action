/**
 * 一键备份系统 — 类型定义
 *
 * 两层架构：GitHub API + 本地文件夹
 */
import { projectBackupSegment } from './utils';

// ─── 备份类型 ─────────────────────────────────────────────

export type BackupType = 'full' | 'github-only' | 'local-only';
export type BackupStatus = 'success' | 'partial' | 'failed';
export type BackupTrigger = 'manual' | 'schedule' | 'api';
export type BackupPhase =
  | 'github-commit'
  | 'github-push'
  | 'local-copy'
  | 'local-metadata';

// ─── 配置 ─────────────────────────────────────────────────

export interface GitHubBackupConfig {
  enabled: boolean;
  owner: string;
  repo: string;
  branch: string;
  commitPrefix: string;
  excludePatterns: string[];
}

/** 快照载体形态：zip 为单文件归档，directory 为目录镜像（旧行为） */
export type LocalBackupFormat = 'zip' | 'directory';

export interface LocalBackupConfig {
  enabled: boolean;
  backupDir: string;
  maxBackups: number;
  excludePatterns: string[];
  compress: boolean;
  format: LocalBackupFormat;
}

export interface BackupScheduleConfig {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string;            // HH:mm
  dayOfWeek?: number;      // 0=Sun, weekly
  dayOfMonth?: number;     // monthly
}

export interface BackupConfig {
  github: GitHubBackupConfig;
  local: LocalBackupConfig;
  schedule: BackupScheduleConfig;
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  '.next/',
  '.nyc_output/',
  'coverage/',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  '.env',
  '.env.local',
];

export interface BackupIdentity {
  projectId?: string;
  projectName?: string;
  projectPath?: string;
}

export function defaultBackupConfig(identity?: BackupIdentity): BackupConfig {
  const segment = projectBackupSegment(
    identity?.projectPath ?? identity?.projectId,
    identity?.projectName,
  );
  const backupDir = segment ? `~/zhshield-backups/${segment}` : '~/zhshield-backups';
  return {
    github: {
      enabled: false,
      owner: '',
      repo: '',
      branch: 'main',
      commitPrefix: '[智汇码盾]',
      excludePatterns: ['node_modules/', '.git/', 'dist/', '*.log'],
    },
    local: {
      enabled: true,
      backupDir,
      maxBackups: 10,
      excludePatterns: ['node_modules/', '.git/', 'dist/', 'coverage/'],
      compress: false,
      format: 'zip',
    },
    schedule: {
      enabled: false,
      frequency: 'daily',
      time: '02:00',
    },
  };
}

// ─── 子结果 ───────────────────────────────────────────────

export interface GitHubBackupSubResult {
  type: 'github';
  success: boolean;
  commitHash?: string;
  commitMessage?: string;
  repoUrl?: string;
  branch?: string;
  error?: string;
}

export interface LocalBackupSubResult {
  type: 'local';
  success: boolean;
  backupPath?: string;
  size?: number;
  fileCount?: number;
  error?: string;
}

export type BackupSubResult =
  | GitHubBackupSubResult
  | LocalBackupSubResult;

// ─── 总结果 ───────────────────────────────────────────────

export interface BackupResult {
  projectId: string;
  projectName: string;
  trigger: BackupTrigger;
  results: BackupSubResult[];
  overallStatus: BackupStatus;
  timestamp: Date;
  duration: number;     // ms
  error?: string;
}

// ─── 元数据（持久化） ─────────────────────────────────────

export type BackupTypeTag = 'github' | 'local';

export interface BackupRecord {
  id: string;                    // bk_yyyymmdd_hhmmss
  projectId: string;
  projectName: string;
  projectPath: string;
  timestamp: string;             // ISO
  type: BackupType;
  status: BackupStatus;
  trigger: BackupTrigger;
  duration: number;              // ms

  // GitHub
  githubCommitHash?: string;
  githubCommitMessage?: string;
  githubRepoUrl?: string;
  githubBranch?: string;

  // 本地
  localBackupPath?: string;
  backupSize?: number;
  fileCount?: number;

  error?: string;
}

// ─── 事件载荷 ─────────────────────────────────────────────

export interface BackupRequestPayload {
  projectId: string;
  type: BackupType;
  trigger: BackupTrigger;
}

export interface BackupStartedPayload {
  projectId: string;
  backupId: string;
  type: BackupType;
}

export interface BackupProgressPayload {
  projectId: string;
  backupId: string;
  phase: BackupPhase;
  percent: number;
  message: string;
}

export interface BackupCompletedPayload {
  projectId: string;
  backupId: string;
  result: BackupResult;
}

export interface BackupFailedPayload {
  projectId: string;
  backupId: string;
  error: string;
  partialResult?: BackupResult;
}

export interface BackupConfigUpdatedPayload {
  projectId: string;
  config: BackupConfig;
}

// ─── 事件常量 ─────────────────────────────────────────────

export const BACKUP_EVENTS = {
  REQUEST: 'backup:request',
  STARTED: 'backup:started',
  PROGRESS: 'backup:progress',
  COMPLETED: 'backup:completed',
  FAILED: 'backup:failed',
  CONFIG_UPDATED: 'backup:config-updated',
  LIST_RECORDS: 'backup:list-records',
  GET_DETAIL: 'backup:get-detail',
  DELETE_RECORD: 'backup:delete-record',
} as const;


