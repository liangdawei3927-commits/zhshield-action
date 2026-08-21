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

const TILDE_PREFIX = /^~/;

export interface LocalBackupFileEntry {
  relativePath: string;
  hash: string;
  size: number;
  backedUpAt: string;
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
      const backupDir = path.join(resolvedBackupDir, timestamp.replace(/[:.]/g, '-'));

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
   */
  async restore(
    backupPath: string,
    targetDir: string,
    abortSignal?: AbortSignal,
  ): Promise<number> {
    const manifest = await this.readManifest(backupPath);
    const files = manifest?.files ?? [];
    let restored = 0;

    for (const entry of files) {
      if (abortSignal?.aborted) break;
      const sourcePath = path.join(backupPath, entry.relativePath);
      const targetPath = path.join(targetDir, entry.relativePath);
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.cp(sourcePath, targetPath, { preserveTimestamps: true });
        restored++;
      } catch {
        // skip individual file errors
      }
    }

    return restored;
  }

  /**
   * 列出所有备份目录（按时间倒序）
   */
  async listBackups(backupDir?: string): Promise<string[]> {
    const dir = backupDir ?? this.backupRoot;
    try {
      const entries = await fs.readdir(dir);
      const dirs: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat?.isDirectory()) {
          dirs.push(fullPath);
        }
      }
      return dirs.sort().reverse();
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
        const targetPath = compress
          ? path.join(backupDir, `${relativePath}.gz`)
          : path.join(backupDir, relativePath);
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
