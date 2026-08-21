import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { hashFile } from './utils';

export interface BackupFileEntry {
  relativePath: string;
  hash: string;
  size: number;
  backedUpAt: string;
}

export interface BackupManifest {
  version: string;
  sourceDir: string;
  lastBackupAt: string;
  fullBackupAt: string;
  files: BackupFileEntry[];
}

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

export interface BackupOptions {
  sourceDir?: string;
  backupRoot?: string;
  maxBackups?: number;
  includePatterns?: RegExp[];
  excludePatterns?: RegExp[];
}

interface PreparedRun {
  manifest: BackupManifest | null;
  files: string[];
  timestamp: string;
  backupDir: string;
  isFullBackup: boolean;
}

interface CopyResult {
  filesBackedUp: number;
  filesSkipped: number;
  errors: number;
  totalSize: number;
  fileEntries: BackupFileEntry[];
}

type CopyOutcome =
  | { kind: 'skipped'; entry: BackupFileEntry }
  | { kind: 'copied'; entry: BackupFileEntry; size: number }
  | { kind: 'error' };

const DEFAULT_INCLUDE: RegExp[] = [
  /\.json$/,
  /\.jsonl$/,
  /\.db$/,
  /\.yaml$/,
  /\.yml$/,
  /\.gz$/,
];

const DEFAULT_EXCLUDE: RegExp[] = [
  /backups?\//,
  /node_modules\//,
  /\.git\//,
];

const MANIFEST_VERSION = '1.0';

export class BackupManager {
  private sourceDir: string;
  private backupRoot: string;
  private maxBackups: number;
  private includePatterns: RegExp[];
  private excludePatterns: RegExp[];

  constructor(options?: BackupOptions) {
    this.sourceDir = options?.sourceDir ?? path.join(os.homedir(), '.zhshield');
    this.backupRoot = options?.backupRoot ?? path.join(this.sourceDir, 'backups');
    this.maxBackups = options?.maxBackups ?? 10;
    this.includePatterns = options?.includePatterns ?? DEFAULT_INCLUDE;
    this.excludePatterns = options?.excludePatterns ?? DEFAULT_EXCLUDE;
  }

  async run(): Promise<BackupResult> {
    const prepared = await this.prepareRun();
    const copyResult = await this.copyChangedFiles(prepared);
    await this.finalizeBackup(prepared, copyResult.fileEntries);

    return this.buildResult(prepared, copyResult);
  }

  private async prepareRun(): Promise<PreparedRun> {
    await fs.mkdir(this.backupRoot, { recursive: true });

    const manifest = await this.loadManifest();
    const files = await this.scanFiles();
    const timestamp = new Date().toISOString();
    const backupDir = path.join(this.backupRoot, timestamp.replace(/[:.]/g, '-'));

    return {
      manifest,
      files,
      timestamp,
      backupDir,
      isFullBackup: !manifest || manifest.files.length === 0,
    };
  }

  private async copyChangedFiles(prepared: PreparedRun): Promise<CopyResult> {
    const { files, manifest, backupDir, timestamp, isFullBackup } = prepared;
    let filesBackedUp = 0;
    let filesSkipped = 0;
    let errors = 0;
    let totalSize = 0;
    const fileEntries: BackupFileEntry[] = [];

    for (const filePath of files) {
      const outcome = await this.copyOneFile(filePath, { manifest, backupDir, timestamp, isFullBackup });
      if (outcome.kind === 'skipped') {
        fileEntries.push(outcome.entry);
        filesSkipped++;
      } else if (outcome.kind === 'copied') {
        fileEntries.push(outcome.entry);
        totalSize += outcome.size;
        filesBackedUp++;
      } else {
        errors++;
      }
    }

    return { filesBackedUp, filesSkipped, errors, totalSize, fileEntries };
  }

  private async copyOneFile(
    filePath: string,
    params: { manifest: BackupManifest | null; backupDir: string; timestamp: string; isFullBackup: boolean },
  ): Promise<CopyOutcome> {
    const relativePath = path.relative(this.sourceDir, filePath);
    const hash = await hashFile(filePath);
    const existing = params.manifest?.files.find(
      (f) => f.relativePath === relativePath,
    );

    if (!params.isFullBackup && existing && existing.hash === hash) {
      return { kind: 'skipped', entry: existing };
    }

    return this.copyFileToBackup(filePath, hash, params.backupDir, params.timestamp);
  }

  private async copyFileToBackup(
    filePath: string,
    hash: string,
    backupDir: string,
    timestamp: string,
  ): Promise<{ kind: 'copied'; entry: BackupFileEntry; size: number } | { kind: 'error' }> {
    const relativePath = path.relative(this.sourceDir, filePath);
    const stat = await fs.stat(filePath);
    const targetPath = path.join(backupDir, relativePath);
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.cp(filePath, targetPath, { preserveTimestamps: true });
      return {
        kind: 'copied',
        size: stat.size,
        entry: { relativePath, hash, size: stat.size, backedUpAt: timestamp },
      };
    } catch {
      return { kind: 'error' };
    }
  }

  private async finalizeBackup(prepared: PreparedRun, fileEntries: BackupFileEntry[]): Promise<void> {
    await this.writeManifest(prepared.backupDir, prepared.timestamp, prepared.isFullBackup, fileEntries);
    await this.updateManifestFile(fileEntries, prepared.timestamp, prepared.isFullBackup);
    await this.pruneOldBackups();
  }

  private buildResult(prepared: PreparedRun, copyResult: CopyResult): BackupResult {
    return {
      fullBackup: prepared.isFullBackup,
      filesBackedUp: copyResult.filesBackedUp,
      filesSkipped: copyResult.filesSkipped,
      errors: copyResult.errors,
      totalSize: copyResult.totalSize,
      backupDir: prepared.backupDir,
      manifestPath: path.join(prepared.backupDir, 'BACKUP_MANIFEST.json'),
      timestamp: prepared.timestamp,
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
      const sourcePath = path.join(latestBackup, entry.relativePath);
      const targetPath = path.join(restoreTo, entry.relativePath);
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.cp(sourcePath, targetPath, { preserveTimestamps: true });
        restored++;
      } catch {
        continue;
      }
    }
    return restored;
  }

  // ─── 查询 ─────────────────────────────────────────────

  async listBackups(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.backupRoot);
      const dirs: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(this.backupRoot, entry);
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

  private async walkFiles(dir: string, results: string[]): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(this.sourceDir, fullPath);
      if (this.excludePatterns.some((p) => p.test(relativePath))) continue;

      if (entry.isDirectory()) {
        await this.walkFiles(fullPath, results);
        continue;
      }
      if (entry.isFile() && this.includePatterns.some((p) => p.test(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  private async loadManifest(): Promise<BackupManifest | null> {
    const manifestPath = path.join(this.backupRoot, 'MANIFEST.json');
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      return JSON.parse(content) as BackupManifest;
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

  private async pruneOldBackups(): Promise<void> {
    const dirs = await this.listBackups();
    if (dirs.length <= this.maxBackups) return;

    const toRemove = dirs.slice(this.maxBackups);
    for (const dir of toRemove) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
      }
    }
  }
}
