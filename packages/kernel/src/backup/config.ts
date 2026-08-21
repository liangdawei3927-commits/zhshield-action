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
  defaultBackupConfig,
} from './types';

export interface BackupGlobalConfig {
  defaultBackupDir: string;
  defaultMaxBackups: number;
  autoBackupEnabled: boolean;
  notifyOnComplete: boolean;
}

export const DEFAULT_GLOBAL_CONFIG: BackupGlobalConfig = {
  defaultBackupDir: path.join(os.homedir(), 'zhshield-backups'),
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

  constructor(globalConfig?: Partial<BackupGlobalConfig>) {
    this.globalConfig = { ...DEFAULT_GLOBAL_CONFIG, ...globalConfig };
    this.globalConfigPath = path.join(os.homedir(), GLOBAL_CONFIG_FILE);
  }

  // ─── 项目配置 ───────────────────────────────────────────

  /**
   * 从项目根目录加载备份配置
   * 如果文件不存在，返回默认配置
   */
  async loadProjectConfig(projectRoot: string): Promise<BackupConfig> {
    const configPath = this.projectConfigPath(projectRoot);
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const parsed = yaml.load(raw) as Record<string, unknown>;
      if (!parsed?.backup) return defaultBackupConfig();
      return this.normalizeConfig(parsed.backup as Record<string, unknown>);
    } catch {
      return defaultBackupConfig();
    }
  }

  /**
   * 保存备份配置到项目根目录
   */
  async saveProjectConfig(projectRoot: string, config: BackupConfig): Promise<void> {
    const dir = path.join(projectRoot, ZH_SHIELD_DIR);
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
    try {
      const raw = await fs.readFile(this.globalConfigPath, 'utf-8');
      return { ...DEFAULT_GLOBAL_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_GLOBAL_CONFIG };
    }
  }

  async saveGlobalConfig(config: Partial<BackupGlobalConfig>): Promise<void> {
    this.globalConfig = { ...this.globalConfig, ...config };
    await fs.writeFile(this.globalConfigPath, JSON.stringify(this.globalConfig, null, 2), 'utf-8');
  }

  getGlobalConfig(): BackupGlobalConfig {
    return { ...this.globalConfig };
  }

  // ─── 私有 ───────────────────────────────────────────────

  private projectConfigPath(projectRoot: string): string {
    return path.join(projectRoot, ZH_SHIELD_DIR, BACKUP_CONFIG_FILE);
  }

  private normalizeConfig(raw: Record<string, unknown>): BackupConfig {
    const def = defaultBackupConfig();
    return {
      github: this.normalizeGitHub(raw.github as Partial<GitHubBackupConfig> | undefined, def.github),
      local: this.normalizeLocal(raw.local as Partial<LocalBackupConfig> | undefined, def.local),
      schedule: this.normalizeSchedule(raw.schedule as Partial<BackupScheduleConfig> | undefined, def.schedule),
    };
  }

  private normalizeGitHub(raw: Partial<GitHubBackupConfig> | undefined, def: GitHubBackupConfig): GitHubBackupConfig {
    return {
      enabled: raw?.enabled ?? def.enabled,
      owner: raw?.owner ?? def.owner,
      repo: raw?.repo ?? def.repo,
      branch: raw?.branch ?? def.branch,
      commitPrefix: raw?.commitPrefix ?? def.commitPrefix,
      excludePatterns: raw?.excludePatterns ?? def.excludePatterns,
    };
  }

  private normalizeLocal(raw: Partial<LocalBackupConfig> | undefined, def: LocalBackupConfig): LocalBackupConfig {
    return {
      enabled: raw?.enabled ?? def.enabled,
      backupDir: raw?.backupDir ?? def.backupDir,
      maxBackups: raw?.maxBackups ?? def.maxBackups,
      excludePatterns: raw?.excludePatterns ?? def.excludePatterns,
      compress: raw?.compress ?? def.compress,
    };
  }

  private normalizeSchedule(raw: Partial<BackupScheduleConfig> | undefined, def: BackupScheduleConfig): BackupScheduleConfig {
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
        },
        schedule: {
          enabled: config.schedule.enabled,
          frequency: config.schedule.frequency,
          time: config.schedule.time,
        },
      },
    };

    return yaml.dump(obj, { indent: 2, lineWidth: 120 });
  }
}


