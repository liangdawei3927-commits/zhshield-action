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
export type BackupPhase = 'github-commit' | 'github-push' | 'local-copy' | 'local-metadata';

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
  time: string; // HH:mm
  dayOfWeek?: number; // 0=Sun, weekly
  dayOfMonth?: number; // monthly
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

/**
 * 默认备份根目录（波浪号形式，落盘配置与展示统一用这一种写法，
 * 由 LocalBackup.resolveBackupDir 在真正使用时展开为 home）。
 */
export const DEFAULT_BACKUP_ROOT = '~/zhshield-backups';

/**
 * 生成默认备份配置。
 *
 * `rootDir` 允许调用方（BackupConfigManager）注入全局配置里的默认备份根目录 ——
 * 早先这里硬编码 `~/zhshield-backups`，导致全局配置项 defaultBackupDir
 * 写进文件也永远不生效（用户改了备份位置却毫无变化）。
 */
export function defaultBackupConfig(
  identity?: BackupIdentity,
  rootDir: string = DEFAULT_BACKUP_ROOT,
): BackupConfig {
  const segment = projectBackupSegment(
    identity?.projectPath ?? identity?.projectId,
    identity?.projectName,
  );
  const base = rootDir.replace(/[/\\]+$/, '') || DEFAULT_BACKUP_ROOT;
  const backupDir = segment ? `${base}/${segment}` : base;
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

export type BackupSubResult = GitHubBackupSubResult | LocalBackupSubResult;

// ─── 总结果 ───────────────────────────────────────────────

export interface BackupResult {
  projectId: string;
  projectName: string;
  trigger: BackupTrigger;
  results: BackupSubResult[];
  overallStatus: BackupStatus;
  timestamp: Date;
  duration: number; // ms
  error?: string;
}

// ─── 元数据（持久化） ─────────────────────────────────────

export type BackupTypeTag = 'github' | 'local';

export interface BackupRecord {
  id: string; // bk_yyyymmdd_hhmmss
  projectId: string;
  projectName: string;
  projectPath: string;
  timestamp: string; // ISO
  type: BackupType;
  status: BackupStatus;
  trigger: BackupTrigger;
  duration: number; // ms

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

// ─── 本地备份运行态类型（local-backup 与子模块共享，避免彼此反向 import 形成循环） ──

/** 备份条目落盘压缩格式（写入 BACKUP_MANIFEST.json，恢复时按此解压） */
export type LocalBackupCompression = 'none' | 'gzip';

export interface LocalBackupFileEntry {
  relativePath: string;
  hash: string;
  size: number;
  backedUpAt: string;
  /**
   * 实际落盘文件名（备份目录内相对路径）。
   * 旧版清单缺省此字段：视为与 relativePath 相同。
   */
  storedAs?: string;
  /**
   * 落盘压缩格式。旧版清单缺省此字段时按 'none' 处理，
   * 恢复阶段对缺失文件用 gzip 魔数嗅探兜底（兼容旧版 compress:true 目录）。
   */
  compression?: LocalBackupCompression;
}

/** restore() 结果：成功/失败计数与逐条失败原因（匹配 orchestrator 的错误聚合风格） */
export interface LocalBackupRestoreResult {
  restored: number;
  failed: number;
  problems: string[];
}

export interface LocalBackupManifest {
  version: string;
  sourceDir: string;
  lastBackupAt: string;
  fullBackupAt: string;
  files: LocalBackupFileEntry[];
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
