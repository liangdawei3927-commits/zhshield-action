/**
 * 一键备份系统 — 配置管理
 *
 * 读取/写入项目级 .zhshield/backup.yml，管理 GlobalConfig
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import {
  type BackupConfig,
  type GitHubBackupConfig,
  type LocalBackupConfig,
  type BackupScheduleConfig,
  DEFAULT_BACKUP_ROOT,
  defaultBackupConfig,
} from './types';
import { safeJoinReal } from '@zh/shared';
import { normalizeKeepCount } from './retention';

/**
 * 备份全局默认配置：持久化于 ~/.zhshield-backup-global.json，
 * 为所有项目提供兜底默认值，可被项目级配置或构造参数覆盖。
 */
export interface BackupGlobalConfig {
  defaultBackupDir: string;
  defaultMaxBackups: number;
  autoBackupEnabled: boolean;
  notifyOnComplete: boolean;
}

export const DEFAULT_GLOBAL_CONFIG: BackupGlobalConfig = {
  defaultBackupDir: DEFAULT_BACKUP_ROOT,
  defaultMaxBackups: 10,
  autoBackupEnabled: false,
  notifyOnComplete: true,
};

const ZH_SHIELD_DIR = '.zhshield';
const BACKUP_CONFIG_FILE = 'backup.yml';
const GLOBAL_CONFIG_FILE = '.zhshield-backup-global.json';

export class BackupConfigManager {
  private globalConfig: BackupGlobalConfig;
  private globalConfigPath: string;
  /** 构造时显式传入的默认备份目录（显式注入优先于持久化文件，便于测试与程序化覆盖） */
  private explicitDefaultBackupDir?: string;

  /**
   * @param globalConfig 全局默认配置（显式注入的 defaultBackupDir 优先于持久化文件）
   * @param options.globalConfigPath 覆盖全局配置文件位置（测试用，避免读到开发机真实 home）
   */
  constructor(globalConfig?: Partial<BackupGlobalConfig>, options?: { globalConfigPath?: string }) {
    this.globalConfig = { ...DEFAULT_GLOBAL_CONFIG, ...globalConfig };
    this.globalConfigPath =
      options?.globalConfigPath ?? path.join(os.homedir(), GLOBAL_CONFIG_FILE);
    this.explicitDefaultBackupDir = globalConfig?.defaultBackupDir;
  }

  // ─── 项目配置 ───────────────────────────────────────────

  /**
   * 从项目根目录加载备份配置
   * 如果文件不存在，返回按项目隔离的默认配置（projectName 仅影响子目录可读名；
   * 根目录取自生效的全局配置 defaultBackupDir）
   */
  async loadProjectConfig(projectRoot: string, projectName?: string): Promise<BackupConfig> {
    const configPath = this.projectConfigPath(projectRoot);
    const def = defaultBackupConfig(
      { projectPath: projectRoot, projectName },
      await this.resolveGlobalBackupDir(),
    );
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const parsed = yaml.load(raw) as Record<string, unknown>;
      if (!parsed?.backup) return def;
      return this.normalizeConfig(parsed.backup as Record<string, unknown>, def);
    } catch {
      return def;
    }
  }

  /**
   * 保存备份配置到项目根目录
   */
  async saveProjectConfig(projectRoot: string, config: BackupConfig): Promise<void> {
    const dir = safeJoinReal(projectRoot, ZH_SHIELD_DIR);
    await fs.mkdir(dir, { recursive: true });

    const yamlContent = this.serializeConfig(config);
    await fs.writeFile(this.projectConfigPath(projectRoot), yamlContent, 'utf-8');
  }

  /**
   * 判断项目是否有备份配置文件
   */
  async hasProjectConfig(projectRoot: string): Promise<boolean> {
    try {
      await fs.access(this.projectConfigPath(projectRoot));
      return true;
    } catch {
      return false;
    }
  }

  // ─── 全局配置 ───────────────────────────────────────────

  async loadGlobalConfig(): Promise<BackupGlobalConfig> {
    const persisted = await this.readPersistedGlobalConfig();
    return { ...DEFAULT_GLOBAL_CONFIG, ...this.globalConfig, ...persisted };
  }

  async saveGlobalConfig(config: Partial<BackupGlobalConfig>): Promise<void> {
    this.globalConfig = { ...this.globalConfig, ...config };
    if (config.defaultBackupDir) this.explicitDefaultBackupDir = config.defaultBackupDir;
    await fs.writeFile(this.globalConfigPath, JSON.stringify(this.globalConfig, null, 2), 'utf-8');
  }

  getGlobalConfig(): BackupGlobalConfig {
    return { ...this.globalConfig };
  }

  /**
   * 生效的默认备份根目录（loadProjectConfig 生成默认值时的根）。
   *
   * 优先级：构造时显式注入 > 持久化的全局配置文件（用户显式设置）> 内置默认。
   * 未设置时三者同为 '~/zhshield-backups'，故行为与旧版一致。
   */
  private async resolveGlobalBackupDir(): Promise<string> {
    if (this.explicitDefaultBackupDir) return this.explicitDefaultBackupDir;
    const persisted = await this.readPersistedGlobalConfig();
    return persisted?.defaultBackupDir ?? this.globalConfig.defaultBackupDir;
  }

  /** 读取持久化的全局配置；文件不存在或损坏时返回 null（交由调用方决定回退） */
  private async readPersistedGlobalConfig(): Promise<Partial<BackupGlobalConfig> | null> {
    try {
      const raw = await fs.readFile(this.globalConfigPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Partial<BackupGlobalConfig>) : null;
    } catch {
      return null;
    }
  }

  // ─── 私有 ───────────────────────────────────────────────

  private projectConfigPath(projectRoot: string): string {
    return safeJoinReal(projectRoot, ZH_SHIELD_DIR, BACKUP_CONFIG_FILE);
  }

  private normalizeConfig(raw: Record<string, unknown>, def: BackupConfig): BackupConfig {
    return {
      github: this.normalizeGitHub(
        raw.github as Partial<GitHubBackupConfig> | undefined,
        def.github,
      ),
      local: this.normalizeLocal(raw.local as Partial<LocalBackupConfig> | undefined, def.local),
      schedule: this.normalizeSchedule(
        raw.schedule as Partial<BackupScheduleConfig> | undefined,
        def.schedule,
      ),
    };
  }

  private normalizeGitHub(
    raw: Partial<GitHubBackupConfig> | undefined,
    def: GitHubBackupConfig,
  ): GitHubBackupConfig {
    return {
      enabled: raw?.enabled ?? def.enabled,
      owner: raw?.owner ?? def.owner,
      repo: raw?.repo ?? def.repo,
      branch: raw?.branch ?? def.branch,
      commitPrefix: raw?.commitPrefix ?? def.commitPrefix,
      excludePatterns: raw?.excludePatterns ?? def.excludePatterns,
    };
  }

  private normalizeLocal(
    raw: Partial<LocalBackupConfig> | undefined,
    def: LocalBackupConfig,
  ): LocalBackupConfig {
    return {
      enabled: raw?.enabled ?? def.enabled,
      backupDir: raw?.backupDir ?? def.backupDir,
      maxBackups: normalizeKeepCount(raw?.maxBackups, def.maxBackups),
      excludePatterns: raw?.excludePatterns ?? def.excludePatterns,
      compress: raw?.compress ?? def.compress,
      format: raw?.format === 'directory' ? 'directory' : 'zip',
    };
  }

  private normalizeSchedule(
    raw: Partial<BackupScheduleConfig> | undefined,
    def: BackupScheduleConfig,
  ): BackupScheduleConfig {
    return {
      enabled: raw?.enabled ?? def.enabled,
      frequency: raw?.frequency ?? def.frequency,
      time: raw?.time ?? def.time,
      dayOfWeek: raw?.dayOfWeek ?? def.dayOfWeek,
      dayOfMonth: raw?.dayOfMonth ?? def.dayOfMonth,
    };
  }

  private serializeConfig(config: BackupConfig): string {
    const obj: Record<string, unknown> = {
      backup: {
        github: {
          enabled: config.github.enabled,
          owner: config.github.owner,
          repo: config.github.repo,
          branch: config.github.branch,
          commitPrefix: config.github.commitPrefix,
          excludePatterns: config.github.excludePatterns,
        },
        local: {
          enabled: config.local.enabled,
          backupDir: config.local.backupDir,
          maxBackups: config.local.maxBackups,
          excludePatterns: config.local.excludePatterns,
          compress: config.local.compress,
          format: config.local.format,
        },
        schedule: {
          enabled: config.schedule.enabled,
          frequency: config.schedule.frequency,
          time: config.schedule.time,
          // weekly/monthly 需要的日期字段：此前序列化丢弃导致保存后调度回退为每天
          ...(config.schedule.dayOfWeek !== undefined
            ? { dayOfWeek: config.schedule.dayOfWeek }
            : {}),
          ...(config.schedule.dayOfMonth !== undefined
            ? { dayOfMonth: config.schedule.dayOfMonth }
            : {}),
        },
      },
    };

    return yaml.dump(obj, { indent: 2, lineWidth: 120 });
  }
}
