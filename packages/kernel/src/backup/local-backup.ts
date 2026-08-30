/**
 * 一键备份系统 — 本地文件夹备份（优先级 3）
 *
 * 基于现有 BackupManager 增强，支持配置化排除、压缩、元数据持久化。
 * 职责拆分：扫描/清单/复制/轮换/还原分别委托给独立类，保持单类行数与职责可控。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { type LocalBackupConfig, type LocalBackupSubResult } from './types';
import { buildZipSnapshot, restoreFromZipArchive } from './zip-snapshot';
import { safeJoinReal } from '@zh/shared';
import { LocalBackupScanner } from './local-backup-scanner';
import { LocalBackupManifestStore } from './local-backup-manifest';
import { LocalBackupCopier } from './local-backup-copier';
import { LocalBackupPruner } from './local-backup-pruner';
import { LocalBackupRestorer } from './local-backup-restorer';

const TILDE_PREFIX = /^~/;

/** 快照条目名（ISO 时间戳目录或同名 .zip）；不匹配的条目（pre-restore-*、MANIFEST.json 等）不参与轮换 */
const SNAPSHOT_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(\.zip)?$/;

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

export class LocalBackup {
  private backupRoot: string;
  private readonly scanner = new LocalBackupScanner();
  private readonly manifestStore = new LocalBackupManifestStore();
  private readonly copier = new LocalBackupCopier();
  private readonly pruner = new LocalBackupPruner();
  private readonly restorer = new LocalBackupRestorer();

  constructor(backupRoot?: string) {
    this.backupRoot = backupRoot ?? path.join(os.homedir(), 'zhshield-backups');
  }

  /**
   * 执行本地备份
   * 创建带时间戳的备份目录 → 增量复制文件（hash 对比）→ 生成 manifest → 清理旧备份
   */
  async backup(
    projectPath: string,
    config: LocalBackupConfig,
    abortSignal?: AbortSignal,
  ): Promise<LocalBackupSubResult> {
    try {
      const resolvedBackupDir = this.resolveBackupDir(config);
      await fs.mkdir(resolvedBackupDir, { recursive: true });

      const manifest = await this.manifestStore.loadManifest(resolvedBackupDir);
      const files = await this.scanner.scanFiles(projectPath, config.excludePatterns, abortSignal);
      const timestamp = new Date().toISOString();
      const snapshotName = timestamp.replace(/[:.]/g, '-');

      if (config.format === 'zip') {
        return await this.runZipBackup(resolvedBackupDir, snapshotName, files, projectPath, timestamp, config, abortSignal);
      }
      return await this.runDirectoryBackup(resolvedBackupDir, snapshotName, files, manifest, projectPath, timestamp, config, abortSignal);
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知本地备份错误';
      return {
        type: 'local',
        success: false,
        error: message,
      };
    }
  }

  /** 解析备份根目录（支持 ~ 前缀展开） */
  private resolveBackupDir(config: LocalBackupConfig): string {
    return config.backupDir
      ? config.backupDir.replace(TILDE_PREFIX, os.homedir())
      : this.backupRoot;
  }

  /** zip 格式备份：构建快照归档并轮换旧备份 */
  private async runZipBackup(
    resolvedBackupDir: string,
    snapshotName: string,
    files: string[],
    projectPath: string,
    timestamp: string,
    config: LocalBackupConfig,
    abortSignal?: AbortSignal,
  ): Promise<LocalBackupSubResult> {
    const zipPath = safeJoinReal(resolvedBackupDir, `${snapshotName}.zip`);
    const stats = await buildZipSnapshot({ files, projectPath, timestamp, zipPath, abortSignal });
    if (!abortSignal?.aborted) {
      await this.pruneOldBackups(resolvedBackupDir, config.maxBackups);
    }
    return {
      type: 'local',
      success: stats.errors === 0 || stats.backedUp > 0,
      backupPath: zipPath,
      size: stats.totalSize,
      fileCount: stats.backedUp,
      ...(stats.errors > 0 && stats.backedUp === 0 ? { error: `${stats.errors} 个文件打包失败` } : {}),
    };
  }

  /** 目录格式备份：增量复制文件、写清单并轮换旧备份 */
  private async runDirectoryBackup(
    resolvedBackupDir: string,
    snapshotName: string,
    files: string[],
    manifest: LocalBackupManifest | null,
    projectPath: string,
    timestamp: string,
    config: LocalBackupConfig,
    abortSignal?: AbortSignal,
  ): Promise<LocalBackupSubResult> {
    const backupDir = safeJoinReal(resolvedBackupDir, snapshotName);
    const isFullBackup = !manifest || manifest.files.length === 0;
    const { backedUp, errors, totalSize, fileEntries } = await this.copier.copyChangedFiles(
      files,
      manifest,
      isFullBackup,
      backupDir,
      projectPath,
      timestamp,
      abortSignal,
      config.compress,
    );

    if (!abortSignal?.aborted) {
      await this.manifestStore.writeManifest(backupDir, timestamp, isFullBackup, fileEntries);
      await this.manifestStore.updateManifestFile(resolvedBackupDir, fileEntries, timestamp, isFullBackup);
      await this.pruneOldBackups(resolvedBackupDir, config.maxBackups);
    }

    return {
      type: 'local',
      success: errors === 0 || backedUp > 0,
      backupPath: backupDir,
      size: totalSize,
      fileCount: backedUp,
      ...(errors > 0 && backedUp === 0 ? { error: `${errors} 个文件复制失败` } : {}),
    };
  }

  /**
   * 从备份恢复项目
   *
   * 按清单 recorded 的 storedAs/compression 解压还原；旧版清单（无格式字段）
   * 通过「期望文件缺失 → 尝试 .gz 后缀 → gzip 魔数嗅探」兜底。
   */
  async restore(
    backupPath: string,
    targetDir: string,
    abortSignal?: AbortSignal,
  ): Promise<LocalBackupRestoreResult> {
    const stat = await fs.stat(backupPath).catch(() => null);
    if (stat?.isFile()) {
      return restoreFromZipArchive(backupPath, targetDir, abortSignal);
    }
    const files = await this.restorer.readManifestFiles(backupPath);
    return this.restorer.restoreDirectoryEntries(backupPath, files, targetDir, abortSignal);
  }

  /**
   * 列出所有备份目录（按时间倒序）
   */
  async listBackups(backupDir?: string): Promise<string[]> {
    const dir = backupDir ?? this.backupRoot;
    try {
      const entries = await fs.readdir(dir);
      const snapshots: string[] = [];
      for (const entry of entries) {
        if (!SNAPSHOT_NAME_RE.test(entry)) continue;
        const fullPath = path.join(dir, entry);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat?.isDirectory() || stat?.isFile()) {
          snapshots.push(fullPath);
        }
      }
      return snapshots.sort().reverse();
    } catch {
      return [];
    }
  }

  // ─── 私有 ─────────────────────────────────────────────

  private async pruneOldBackups(backupRoot: string, maxBackups: number): Promise<void> {
    const dirs = await this.listBackups(backupRoot);
    await this.pruner.pruneOldBackups(dirs, maxBackups);
  }
}
