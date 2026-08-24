/**
 * 一键备份系统 — 本地文件夹备份（优先级 3）
 *
 * 基于现有 BackupManager 增强，支持配置化排除、压缩、元数据持久化。
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { type LocalBackupConfig, type LocalBackupSubResult } from './types';
import { hashFile, matchesExcludePattern } from './utils';
import { restoreStoredEntry } from './restore-entry';
import { buildZipSnapshot, restoreFromZipArchive } from './zip-snapshot';

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
      const resolvedBackupDir = config.backupDir
        ? config.backupDir.replace(TILDE_PREFIX, os.homedir())
        : this.backupRoot;

      await fs.mkdir(resolvedBackupDir, { recursive: true });

      const manifest = await this.loadManifest(resolvedBackupDir);
      const files = await this.scanFiles(projectPath, config.excludePatterns, abortSignal);
      const timestamp = new Date().toISOString();
      const snapshotName = timestamp.replace(/[:.]/g, '-');

      if (config.format === 'zip') {
        const zipPath = path.join(resolvedBackupDir, `${snapshotName}.zip`);
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

      const backupDir = path.join(resolvedBackupDir, snapshotName);

      const isFullBackup = !manifest || manifest.files.length === 0;
      const { backedUp, errors, totalSize, fileEntries } = await this.copyChangedFiles(
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
        await this.writeManifest(backupDir, timestamp, isFullBackup, fileEntries);
        await this.updateManifestFile(resolvedBackupDir, fileEntries, timestamp, isFullBackup);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知本地备份错误';
      return {
        type: 'local',
        success: false,
        error: message,
      };
    }
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

    const manifest = await this.readManifest(backupPath);
    const files = manifest?.files ?? [];
    let restored = 0;
    let failed = 0;
    const problems: string[] = [];

    for (const entry of files) {
      if (abortSignal?.aborted) break;
      const targetPath = path.join(targetDir, entry.relativePath);
      try {
        await restoreStoredEntry(backupPath, targetPath, entry);
        restored++;
      } catch (err) {
        failed++;
        problems.push(`${entry.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { restored, failed, problems };
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

  private async scanFiles(
    rootDir: string,
    excludePatterns: string[],
    abortSignal?: AbortSignal,
  ): Promise<string[]> {
    const results: string[] = [];

    const walk = async (dir: string) => {
      if (abortSignal?.aborted) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

      for (const entry of entries) {
        if (abortSignal?.aborted) return;
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(rootDir, fullPath);

        if (matchesExcludePattern(relativePath, excludePatterns)) continue;

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      }
    };

    await walk(rootDir);
    return results;
  }

  private async loadManifest(backupRoot: string): Promise<LocalBackupManifest | null> {
    const manifestPath = path.join(backupRoot, 'MANIFEST.json');
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      return JSON.parse(content) as LocalBackupManifest;
    } catch {
      return null;
    }
  }

  private async readManifest(backupDir: string): Promise<LocalBackupManifest | null> {
    const manifestPath = path.join(backupDir, 'BACKUP_MANIFEST.json');
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      return JSON.parse(content) as LocalBackupManifest;
    } catch {
      return null;
    }
  }

  private async writeManifest(
    backupDir: string,
    timestamp: string,
    isFullBackup: boolean,
    files: LocalBackupFileEntry[],
  ): Promise<void> {
    const manifest: LocalBackupManifest = {
      version: '1.0',
      sourceDir: backupDir,
      lastBackupAt: timestamp,
      fullBackupAt: isFullBackup ? timestamp : '',
      files,
    };
    await fs.writeFile(
      path.join(backupDir, 'BACKUP_MANIFEST.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  }

  private async updateManifestFile(
    backupRoot: string,
    files: LocalBackupFileEntry[],
    timestamp: string,
    isFullBackup: boolean,
  ): Promise<void> {
    const existing = await this.loadManifest(backupRoot);
    const mergedFiles = isFullBackup ? files : [...(existing?.files ?? []), ...files];
    const manifest: LocalBackupManifest = {
      version: '1.0',
      sourceDir: backupRoot,
      lastBackupAt: timestamp,
      fullBackupAt: existing?.fullBackupAt ?? timestamp,
      files: mergedFiles,
    };
    await fs.writeFile(
      path.join(backupRoot, 'MANIFEST.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  }

  private async pruneOldBackups(backupRoot: string, maxBackups: number): Promise<void> {
    const dirs = await this.listBackups(backupRoot);
    if (dirs.length <= maxBackups) return;

    const toRemove = dirs.slice(maxBackups);
    for (const dir of toRemove) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 复制文件到备份目录，返回备份统计与文件清单。
   * 当前实现为每次全量复制，保证单个备份目录自包含、可直接恢复。
   */
  private async copyChangedFiles(
    files: string[],
    _manifest: LocalBackupManifest | null,
    _isFullBackup: boolean,
    backupDir: string,
    projectPath: string,
    timestamp: string,
    abortSignal?: AbortSignal,
    compress?: boolean,
  ): Promise<{ backedUp: number; errors: number; totalSize: number; fileEntries: LocalBackupFileEntry[] }> {
    const fileEntries: LocalBackupFileEntry[] = [];
    let backedUp = 0;
    let errors = 0;
    let totalSize = 0;

    for (const file of files) {
      if (abortSignal?.aborted) break;
      const relativePath = path.relative(projectPath, file);
      try {
        const [hash, stat] = await Promise.all([hashFile(file), fs.stat(file)]);
        const storedAs = compress ? `${relativePath}.gz` : relativePath;
        const targetPath = path.join(backupDir, storedAs);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        if (compress) {
          await pipeline(
            fsSync.createReadStream(file),
            createGzip(),
            fsSync.createWriteStream(targetPath),
          );
        } else {
          await fs.cp(file, targetPath, { preserveTimestamps: true });
        }
        fileEntries.push({
          relativePath,
          hash,
          size: stat.size,
          backedUpAt: timestamp,
          storedAs,
          compression: compress ? 'gzip' : 'none',
        });
        totalSize += stat.size;
        backedUp++;
      } catch {
        errors++;
      }
    }

    return { backedUp, errors, totalSize, fileEntries };
  }
}
