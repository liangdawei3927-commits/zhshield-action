/**
 * 一键备份系统 — 类型定义
 *
 * 两层架构：GitHub API + 本地文件夹
 */
import { projectBackupSegment } from './utils';

// ─── 备份类型 ─────────────────────────────────────────────

/** 备份方式：全量（同时走 GitHub 与本地）、仅 GitHub、仅本地 */
export type BackupType = 'full' | 'github-only' | 'local-only';
/**
 * 备份整体状态：partial 表示部分子备份成功、部分失败。
 *
 * `cancelled` = 用户主动停止（abortSignal 被 abort）。**它不是失败**：不落记录、
 * 不发 FAILED 事件。把它并入 failed 会让历史记录里躺着一条假失败，用户刚点的
 * 「停止」被自己的系统报成错误。
 */
export type BackupStatus = 'success' | 'partial' | 'failed' | 'cancelled';
/** 备份触发来源：手动、定时调度或 API 调用 */
export type BackupTrigger = 'manual' | 'schedule' | 'api';
/** 备份执行阶段：GitHub 提交、GitHub 推送、本地拷贝、本地元数据写入 */
export type BackupPhase = 'github-commit' | 'github-push' | 'local-copy' | 'local-metadata';

// ─── 配置 ─────────────────────────────────────────────────

/** GitHub 备份配置：目标仓库坐标、推送分支与提交信息前缀 */
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

/** 本地备份配置：存放目录、保留份数、排除规则、体积上限与压缩/载体格式开关 */
export interface LocalBackupConfig {
  enabled: boolean;
  backupDir: string;
  maxBackups: number;
  excludePatterns: string[];
  /**
   * P2-6：单次快照源文件总体积上限（MB）。实测曾有单包 1.5GB 默默打满磁盘。
   * 打包前按扫描文件 size 预估，超限直接失败并给出处置提示，不再静默写盘。
   */
  maxTotalSizeMB: number;
  compress: boolean;
  format: LocalBackupFormat;
}

/**
 * 定时备份配置。
 * dayOfWeek 仅 weekly 生效（0=周日），dayOfMonth 仅 monthly 生效。
 */
export interface BackupScheduleConfig {
  enabled: boolean;
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string; // HH:mm
  dayOfWeek?: number; // 0=Sun, weekly
  dayOfMonth?: number; // monthly
}

/** 备份总配置：GitHub、本地与定时三段配置的聚合（项目级 backup.yml 的根结构） */
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

/**
 * 备份项目身份：用于生成项目级备份目录名。
 * projectPath 优先，其次 projectId，最后退回 projectName。
 */
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

/** 尾部路径分隔符（正/反斜杠），defaultBackupConfig 归一化 rootDir 用 */
const TRAILING_SLASHES = /[/\\]+$/;

/**
 * 生成默认备份配置。
 *
 * `rootDir` 允许调用方（BackupConfigManager）注入全局配置里的默认备份根目录 ——
 * 早先这里硬编码 `~/zhshield-backups`，导致全局配置项 defaultBackupDir
 * 写进文件也永远不生效（用户改了备份位置却毫无变化）。
 */
/**
 * 默认排除的凭据文件（本地 zip 与 GitHub 两侧共用，避免两套默认值漂移）。
 *
 * 「一键备份」无二次确认，且默认落到 ~/zhshield-backups 明文目录；若不排除这些文件，
 * 一次点击就会把 .env / 私钥复制出项目。'.env*' 依赖 matchesExcludePattern 的
 * basename 前缀形式，才能覆盖任意深度的嵌套 .env。
 */
export const DEFAULT_SECRET_EXCLUDE_PATTERNS: readonly string[] = [
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  '.npmrc',
];

/**
 * P2-3：治理产物目录默认排除（本地 zip 与 GitHub 两侧共用）。
 *
 * 备份的价值是"可回滚源码"，把智汇码盾自身的诊断/哨兵/能力账本打进快照，
 * 既膨胀体积（实测单包 1.5GB 的主要成分之一），又让恢复时覆盖掉新鲜的诊断状态。
 * 这些目录在任何项目里都不是源码，故随默认配置强制排除（用户仍可追加自己的排除项）。
 */
export const DEFAULT_GOVERNANCE_EXCLUDE_PATTERNS: readonly string[] = ['.zhshield/', '.omo/'];

/** P2-6：单次快照源文件总体积默认上限（MB）。8GB 常见机型磁盘长期紧张的保守值 */
export const DEFAULT_MAX_BACKUP_SIZE_MB = 512;

export function defaultBackupConfig(
  identity?: BackupIdentity,
  rootDir: string = DEFAULT_BACKUP_ROOT,
): BackupConfig {
  const segment = projectBackupSegment(
    identity?.projectPath ?? identity?.projectId,
    identity?.projectName,
  );
  const base = rootDir.replace(TRAILING_SLASHES, '') || DEFAULT_BACKUP_ROOT;
  const backupDir = segment ? `${base}/${segment}` : base;
  return {
    github: {
      enabled: false,
      owner: '',
      repo: '',
      branch: 'main',
      commitPrefix: '[智汇码盾]',
      excludePatterns: [
        'node_modules/',
        '.git/',
        'dist/',
        '*.log',
        ...DEFAULT_GOVERNANCE_EXCLUDE_PATTERNS,
        ...DEFAULT_SECRET_EXCLUDE_PATTERNS,
      ],
    },
    local: {
      enabled: true,
      backupDir,
      maxBackups: 10,
      excludePatterns: [
        'node_modules/',
        '.git/',
        'dist/',
        'coverage/',
        ...DEFAULT_GOVERNANCE_EXCLUDE_PATTERNS,
        ...DEFAULT_SECRET_EXCLUDE_PATTERNS,
      ],
      maxTotalSizeMB: DEFAULT_MAX_BACKUP_SIZE_MB,
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

/** GitHub 子备份结果：成功时给出 commitHash / repoUrl，失败时给出 error */
export interface GitHubBackupSubResult {
  type: 'github';
  success: boolean;
  commitHash?: string;
  commitMessage?: string;
  repoUrl?: string;
  branch?: string;
  error?: string;
}

/** 本地子备份结果：成功时给出 backupPath / size / fileCount，失败时给出 error */
export interface LocalBackupSubResult {
  type: 'local';
  success: boolean;
  backupPath?: string;
  size?: number;
  fileCount?: number;
  error?: string;
}

/** 子备份结果联合类型：以 type 字段区分 GitHub 与本地两条子结果分支 */
export type BackupSubResult = GitHubBackupSubResult | LocalBackupSubResult;

// ─── 总结果 ───────────────────────────────────────────────

/**
 * 备份总结果：聚合各子结果并给出 overallStatus 与耗时（毫秒）。
 * 运行时结果，用作事件载荷与元数据落盘的来源。
 */
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

/** 备份元数据的目标载体标签：写入 GitHub 仓库还是本地目录 */
export type BackupTypeTag = 'github' | 'local';

/** 备份元数据记录：持久化到本地索引的单次备份摘要，供历史列表与详情查询 */
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

/** backup:request 事件载荷：仅声明要备份的项目与方式，具体执行由编排器接管 */
export interface BackupRequestPayload {
  projectId: string;
  type: BackupType;
  trigger: BackupTrigger;
}

/** backup:started 事件载荷：备份已受理并分配 backupId */
export interface BackupStartedPayload {
  projectId: string;
  backupId: string;
  type: BackupType;
}

/** backup:progress 事件载荷：按 phase 上报当前阶段与完成百分比（0-100） */
export interface BackupProgressPayload {
  projectId: string;
  backupId: string;
  phase: BackupPhase;
  percent: number;
  message: string;
}

/** backup:completed 事件载荷：携带本次备份的完整总结果 */
export interface BackupCompletedPayload {
  projectId: string;
  backupId: string;
  result: BackupResult;
}

/**
 * backup:failed 事件载荷。
 * partialResult 在部分子备份已成功时提供，用于保留已产出的备份信息。
 */
export interface BackupFailedPayload {
  projectId: string;
  backupId: string;
  error: string;
  partialResult?: BackupResult;
}

/** backup:config-updated 事件载荷：广播某项目最新的完整备份配置 */
export interface BackupConfigUpdatedPayload {
  projectId: string;
  config: BackupConfig;
}

// ─── 本地备份运行态类型（local-backup 与子模块共享，避免彼此反向 import 形成循环） ──

/** 备份条目落盘压缩格式（写入 BACKUP_MANIFEST.json，恢复时按此解压） */
export type LocalBackupCompression = 'none' | 'gzip';

/** 本地备份清单中的单文件条目：落盘路径、哈希与大小，storedAs / compression 兼容旧版清单 */
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

/** 本地备份清单：记录备份来源、时间信息与全部文件条目（与增量清单同构） */
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
