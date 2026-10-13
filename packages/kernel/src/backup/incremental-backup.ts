import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { hashFile } from './utils';
import { safeJoinReal } from '@zh/shared';
import { LocalBackupPruner } from './local-backup-pruner';

/** 清单中的单文件记录：相对路径 + 内容哈希，用于增量比对与跳过未变更文件 */
export interface BackupFileEntry {
  relativePath: string;
  hash: string;
  size: number;
  backedUpAt: string;
}

/**
 * 备份清单：描述某次备份覆盖的文件集合与时间信息。
 * lastBackupAt 支撑增量判定，fullBackupAt 记录最近一次全量备份。
 */
export interface BackupManifest {
  version: string;
  sourceDir: string;
  lastBackupAt: string;
  fullBackupAt: string;
  files: BackupFileEntry[];
}

/** 单次备份执行结果：区分全量/增量，报告处理与跳过的文件数、错误数及产物位置 */
export interface BackupResult {
  fullBackup: boolean;
  filesBackedUp: number;
  filesSkipped: number;
  errors: number;
  totalSize: number;
  backupDir: string;
  manifestPath: string;
  timestamp: string;
}

/**
 * 备份可选参数：全部字段缺省时使用模块内 DEFAULT_INCLUDE / DEFAULT_EXCLUDE 等默认值。
 * includePatterns 与 excludePatterns 同时生效，exclude 优先排除。
 */
export interface BackupOptions {
  sourceDir?: string;
  backupRoot?: string;
  maxBackups?: number;
  includePatterns?: RegExp[];
  excludePatterns?: RegExp[];
}

const DEFAULT_INCLUDE: RegExp[] = [/\.json$/, /\.jsonl$/, /\.db$/, /\.yaml$/, /\.yml$/, /\.gz$/];

const DEFAULT_EXCLUDE: RegExp[] = [/backups?\//, /node_modules\//, /\.git\//];

const MANIFEST_VERSION = '1.0';

/** 递归扫描深度上限：防止病态深层目录树导致栈溢出 */
const MAX_WALK_DEPTH = 64;

/** BackupManager.copyChangedFiles 参数对象 */
interface CopyChangedFilesParams {
  files: string[];
  manifest: BackupManifest | null;
  isFullBackup: boolean;
  backupDir: string;
  timestamp: string;
}

/** BackupManager.copyOneFile 参数对象 */
interface CopyOneFileParams {
  filePath: string;
  manifest: BackupManifest | null;
  isFullBackup: boolean;
  backupDir: string;
  timestamp: string;
}

export class BackupManager {
  private sourceDir: string;
  private backupRoot: string;
  private maxBackups: number;
  private includePatterns: RegExp[];
  private excludePatterns: RegExp[];
  /** 唯一的备份删除入口（含「至少保留最新 1 份」护栏，见 retention.ts） */
  private readonly pruner = new LocalBackupPruner();

  constructor(options?: BackupOptions) {
    this.sourceDir = options?.sourceDir ?? path.join(os.homedir(), '.zhshield');
    this.backupRoot = options?.backupRoot ?? path.join(this.sourceDir, 'backups');
    this.maxBackups = options?.maxBackups ?? 10;
    this.includePatterns = options?.includePatterns ?? DEFAULT_INCLUDE;
    this.excludePatterns = options?.excludePatterns ?? DEFAULT_EXCLUDE;
  }

  async run(): Promise<BackupResult> {
    await fs.mkdir(this.backupRoot, { recursive: true });
    const manifest = await this.loadManifest();
    const files = await this.scanFiles();
    const timestamp = new Date().toISOString();
    const backupDir = path.join(this.backupRoot, timestamp.replace(/[:.]/g, '-'));

    const isFullBackup = !manifest || manifest.files.length === 0;
    const { fileEntries, filesBackedUp, filesSkipped, errors, totalSize } =
      await this.copyChangedFiles({ files, manifest, isFullBackup, backupDir, timestamp });
    await this.writeManifest(backupDir, timestamp, isFullBackup, fileEntries);
    await this.updateManifestFile(fileEntries, timestamp, isFullBackup);
    await this.pruneOldBackups();

    return {
      fullBackup: isFullBackup,
      filesBackedUp,
      filesSkipped,
      errors,
      totalSize,
      backupDir,
      manifestPath: path.join(backupDir, 'BACKUP_MANIFEST.json'),
      timestamp,
    };
  }

  /** 增量复制变更文件：hash 相同跳过，其余复制并记录条目 */
  private async copyChangedFiles(params: CopyChangedFilesParams): Promise<{
    fileEntries: BackupFileEntry[];
    filesBackedUp: number;
    filesSkipped: number;
    errors: number;
    totalSize: number;
  }> {
    const { files, manifest, isFullBackup, backupDir, timestamp } = params;
    let filesBackedUp = 0;
    let filesSkipped = 0;
    let errors = 0;
    let totalSize = 0;
    const fileEntries: BackupFileEntry[] = [];

    for (const filePath of files) {
      const result = await this.copyOneFile({ filePath, manifest, isFullBackup, backupDir, timestamp });
      if (result === null) {
        errors++;
        continue;
      }
      fileEntries.push(result.entry);
      if (result.skipped) {
        filesSkipped++;
      } else {
        totalSize += result.entry.size;
        filesBackedUp++;
      }
    }

    return { fileEntries, filesBackedUp, filesSkipped, errors, totalSize };
  }

  /** 复制单个文件到备份目录；hash 相同返回 skipped 标记，复制失败返回 null */
  private async copyOneFile(params: CopyOneFileParams): Promise<{
    entry: BackupFileEntry;
    skipped: boolean;
  } | null> {
    const { filePath, manifest, isFullBackup, backupDir, timestamp } = params;
    const relativePath = path.relative(this.sourceDir, filePath);
    const stat = await fs.stat(filePath);
    const hash = await hashFile(filePath);
    const existing = manifest?.files.find((f) => f.relativePath === relativePath);
    if (!isFullBackup && existing && existing.hash === hash) {
      return { entry: existing, skipped: true };
    }
    try {
      const targetPath = safeJoinReal(backupDir, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.cp(filePath, targetPath, { preserveTimestamps: true });
    } catch {
      return null;
    }
    return {
      entry: {
        relativePath,
        hash,
        size: stat.size,
        backedUpAt: timestamp,
      },
      skipped: false,
    };
  }

  async restore(targetDir?: string): Promise<number> {
    const manifest = await this.loadManifest();
    if (!manifest || manifest.files.length === 0) {
      return 0;
    }

    const restoreTo = targetDir ?? this.sourceDir;
    const latestBackup = await this.findLatestBackup();
    if (!latestBackup) return 0;

    let restored = 0;
    for (const entry of manifest.files) {
      if (await this.restoreOneFile(latestBackup, restoreTo, entry.relativePath)) {
        restored++;
      }
    }
    return restored;
  }

  private async restoreOneFile(
    backupDir: string,
    restoreTo: string,
    relativePath: string,
  ): Promise<boolean> {
    try {
      const sourcePath = safeJoinReal(backupDir, relativePath);
      const targetPath = safeJoinReal(restoreTo, relativePath);
      
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      
      await fs.cp(sourcePath, targetPath, { preserveTimestamps: true });
      return true;
    } catch {
      return false;
    }
  }

  // ─── 查询 ─────────────────────────────────────────────

  async listBackups(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.backupRoot);
      const dirs: string[] = [];
      for (const entry of entries) {
        if (entry === 'node_modules') continue;
        const fullPath = path.join(this.backupRoot, entry);
        // perf rule false positive: arg depends on loop var via dataflow
        // eslint-disable-next-line perf/perf-no-serial-await
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          dirs.push(fullPath);
        }
      }
      return dirs.sort().reverse();
    } catch {
      return [];
    }
  }

  async getManifest(): Promise<BackupManifest | null> {
    return this.loadManifest();
  }

  // ─── 私有 ─────────────────────────────────────────────

  private async scanFiles(): Promise<string[]> {
    const results: string[] = [];
    await this.walkFiles(this.sourceDir, results);
    return results;
  }

  private async walkFiles(dir: string, results: string[], depth = 0): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    const entries = await readDirSafe(dir);
    if (entries === null) return;

    for (const entry of entries) {
      await this.walkEntry(dir, entry, results, depth);
    }
  }

  private async walkEntry(
    dir: string,
    entry: Dirent,
    results: string[],
    depth: number,
  ): Promise<void> {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(this.sourceDir, fullPath);
    if (this.excludePatterns.some((p) => p.test(relativePath))) return;

    if (entry.isDirectory()) {
      
      await this.walkFiles(fullPath, results, depth + 1);
      return;
    }
    if (entry.isFile() && this.includePatterns.some((p) => p.test(entry.name))) {
      results.push(fullPath);
    }
  }

  private async loadManifest(): Promise<BackupManifest | null> {
    const manifestPath = path.join(this.backupRoot, 'MANIFEST.json');
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      const files =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>).files
          : undefined;
      if (!Array.isArray(files)) return null;
      return parsed as BackupManifest;
    } catch {
      return null;
    }
  }

  private async updateManifestFile(
    files: BackupFileEntry[],
    timestamp: string,
    isFullBackup: boolean,
  ): Promise<void> {
    const existing = await this.loadManifest();
    const mergedFiles = isFullBackup ? files : [...(existing?.files ?? []), ...files];
    const manifest: BackupManifest = {
      version: MANIFEST_VERSION,
      sourceDir: this.sourceDir,
      lastBackupAt: timestamp,
      fullBackupAt: existing?.fullBackupAt ?? timestamp,
      files: mergedFiles,
    };
    const manifestPath = path.join(this.backupRoot, 'MANIFEST.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  private async writeManifest(
    backupDir: string,
    timestamp: string,
    isFullBackup: boolean,
    files: BackupFileEntry[],
  ): Promise<void> {
    const manifest: BackupManifest = {
      version: MANIFEST_VERSION,
      sourceDir: this.sourceDir,
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

  private async findLatestBackup(): Promise<string | null> {
    const dirs = await this.listBackups();
    return dirs.length > 0 ? dirs[0] : null;
  }

  /**
   * 轮换清理：委托给唯一的删除入口，避免与本类此前自持的一份 `slice(maxBackups)`
   * 实现分叉（那一份在 maxBackups=0 时会删光全部备份）。
   */
  private async pruneOldBackups(): Promise<void> {
    const dirs = await this.listBackups();
    const { failed } = await this.pruner.pruneOldBackups(dirs, this.maxBackups);
    if (failed.length > 0) {
      console.warn('[incremental-backup] 清理旧备份失败:', failed.join(', '));
    }
  }
}

async function readDirSafe(dir: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}
