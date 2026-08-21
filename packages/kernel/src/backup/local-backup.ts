/**
 * 一键备份系统 — 本地文件夹备份（优先级 3）
 *
 * 基于现有 BackupManager 增强，支持配置化排除、压缩、元数据持久化。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
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

/** copyChangedFiles 参数对象 */
interface CopyChangedFilesParams {
  files: string[];
  manifest: LocalBackupManifest | null;
  isFullBackup: boolean;
  backupDir: string;
  projectPath: string;
  timestamp: string;
  abortSignal?: AbortSignal;
}

interface PreparedBackup {
  resolvedBackupDir: string;
  backupDir: string;
  manifest: LocalBackupManifest | null;
  files: string[];
  timestamp: string;
  isFullBackup: boolean;
}

interface LocalBackupContext {
  projectPath: string;
  config: LocalBackupConfig;
  abortSignal?: AbortSignal;
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
  async backup(ctx: LocalBackupContext, locale?: LanguageCode): Promise<LocalBackupSubResult> {
    try {
      return await this.completeBackup(ctx, locale);
    } catch (err) {
      return this.buildBackupError(err, locale);
    }
  }

  private async completeBackup(ctx: LocalBackupContext, locale?: LanguageCode): Promise<LocalBackupSubResult> {
    const { projectPath, config, abortSignal } = ctx;
    const prepared = await this.prepareBackup(ctx);

    // If compress is enabled, create zip archive
    if (config.compress) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const zipFileName = `backup_${timestamp}.zip`;
      const backupFilePath = path.join(prepared.resolvedBackupDir, zipFileName);

      const { backedUp, errors, totalSize } = await this.createZipArchive({
        files: prepared.files,
        projectPath,
        backupFilePath,
        abortSignal,
      });

      if (!abortSignal?.aborted) {
        await this.pruneOldBackups(prepared.resolvedBackupDir, config.maxBackups);
      }

      return {
        type: 'local',
        success: errors === 0 || backedUp > 0,
        backupPath: backupFilePath,
        size: totalSize,
        fileCount: backedUp,
        ...(errors > 0 && backedUp === 0
          ? { error: translate('engine.kernel.backup.localCopyFailed', locale ?? DEFAULT_LANGUAGE, { count: errors }) }
          : {}),
      };
    }

    // Original behavior: copy files without compression
    const { backedUp, errors, totalSize, fileEntries } = await this.copyChangedFiles({
      files: prepared.files,
      manifest: prepared.manifest,
      isFullBackup: prepared.isFullBackup,
      backupDir: prepared.backupDir,
      projectPath,
      timestamp: prepared.timestamp,
      abortSignal,
    });

    if (!abortSignal?.aborted) {
      await this.finalizeBackup(prepared, fileEntries, config.maxBackups);
    }

    return {
      type: 'local',
      success: errors === 0 || backedUp > 0,
      backupPath: prepared.backupDir,
      size: totalSize,
      fileCount: backedUp,
      ...(errors > 0 && backedUp === 0
        ? { error: translate('engine.kernel.backup.localCopyFailed', locale ?? DEFAULT_LANGUAGE, { count: errors }) }
        : {}),
    };
  }

  private async prepareBackup(ctx: LocalBackupContext): Promise<PreparedBackup> {
    const { projectPath, config, abortSignal } = ctx;

    // If backupDir is empty, use project's .zhshield/backups/
    let resolvedBackupDir: string;
    if (!config.backupDir || config.backupDir.trim() === '') {
      resolvedBackupDir = path.join(projectPath, '.zhshield', 'backups');
    } else {
      resolvedBackupDir = config.backupDir.replace(TILDE_PREFIX, os.homedir());
    }

    await fs.mkdir(resolvedBackupDir, { recursive: true });

    const manifest = await this.loadManifest(resolvedBackupDir);
    const files = await this.scanFiles(projectPath, config.excludePatterns, abortSignal);
    const timestamp = new Date().toISOString();
    const backupDir = path.join(resolvedBackupDir, timestamp.replace(/[:.]/g, '-'));

    return {
      resolvedBackupDir,
      backupDir,
      manifest,
      files,
      timestamp,
      isFullBackup: !manifest || manifest.files.length === 0,
    };
  }

  private async finalizeBackup(
    prepared: PreparedBackup,
    fileEntries: LocalBackupFileEntry[],
    maxBackups: number,
  ): Promise<void> {
    await this.writeManifest(prepared.backupDir, prepared.timestamp, prepared.isFullBackup, fileEntries);
    await this.updateManifestFile(prepared.resolvedBackupDir, fileEntries, prepared.timestamp, prepared.isFullBackup);
    await this.pruneOldBackups(prepared.resolvedBackupDir, maxBackups);
  }

  private buildBackupError(err: unknown, locale?: LanguageCode): LocalBackupSubResult {
    const message = err instanceof Error ? err.message : translate('engine.kernel.backup.unknownLocalError', locale ?? DEFAULT_LANGUAGE);
    return {
      type: 'local',
      success: false,
      error: message,
    };
  }

  private async createZipArchive(params: {
    files: string[];
    projectPath: string;
    backupFilePath: string;
    abortSignal?: AbortSignal;
  }): Promise<{ backedUp: number; errors: number; totalSize: number }> {
    const { files, projectPath, backupFilePath, abortSignal } = params;

    await fs.mkdir(path.dirname(backupFilePath), { recursive: true });

    return new Promise((resolve, reject) => {
      const output = createWriteStream(backupFilePath);
      const archive = archiver('zip', { zlib: { level: 6 } });

      let backedUp = 0;
      let errors = 0;

      output.on('close', () => {
        resolve({ backedUp, errors, totalSize: archive.pointer() });
      });

      archive.on('error', (err: Error) => reject(err));
      archive.on('entry', () => { backedUp++; });

      archive.pipe(output);

      for (const file of files) {
        if (abortSignal?.aborted) { archive.abort(); break; }
        const relativePath = path.relative(projectPath, file);
        try {
          archive.file(file, { name: relativePath });
        } catch {
          errors++;
        }
      }

      archive.finalize();
    });
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
      const results: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat?.isDirectory() || entry.endsWith('.zip')) {
          results.push(fullPath);
        }
      }
      return results.sort().reverse();
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
    await this.collectFiles({ dir: rootDir, rootDir, excludePatterns, abortSignal, results });
    return results;
  }

  private async collectFiles(params: {
    dir: string;
    rootDir: string;
    excludePatterns: string[];
    abortSignal: AbortSignal | undefined;
    results: string[];
  }): Promise<void> {
    const { dir, rootDir, excludePatterns, abortSignal, results } = params;
    if (abortSignal?.aborted) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (abortSignal?.aborted) return;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (matchesExcludePattern(relativePath, excludePatterns)) continue;

      if (entry.isDirectory()) {
        await this.collectFiles({ dir: fullPath, rootDir, excludePatterns, abortSignal, results });
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
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
  private async copyChangedFiles(params: CopyChangedFilesParams): Promise<{ backedUp: number; errors: number; totalSize: number; fileEntries: LocalBackupFileEntry[] }> {
    const { files, backupDir, projectPath, timestamp, abortSignal } = params;
    const fileEntries: LocalBackupFileEntry[] = [];
    let backedUp = 0;
    let errors = 0;
    let totalSize = 0;

    for (const file of files) {
      if (abortSignal?.aborted) break;
      const relativePath = path.relative(projectPath, file);
      try {
        const [hash, stat] = await Promise.all([hashFile(file), fs.stat(file)]);
        const targetPath = path.join(backupDir, relativePath);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.cp(file, targetPath, { preserveTimestamps: true });
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
