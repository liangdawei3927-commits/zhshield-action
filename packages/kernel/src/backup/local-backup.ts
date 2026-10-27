/**
 * 一键备份系统 — 本地文件夹备份（优先级 3）
 *
 * 基于现有 BackupManager 增强，支持配置化排除、压缩、元数据持久化。
 * 职责拆分：扫描/清单/复制/轮换/还原分别委托给独立类，保持单类行数与职责可控。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  type LocalBackupConfig,
  type LocalBackupSubResult,
  type LocalBackupCompression,
  type LocalBackupFileEntry,
  type LocalBackupManifest,
  type LocalBackupRestoreResult,
} from './types';
import { buildZipSnapshot, restoreFromZipArchive } from './zip-snapshot';
import { expandHome, safeJoinReal } from '@zh/shared';
import { estimateFilesTotalSize, backupSizeLimitError } from './utils';
import { LocalBackupScanner } from './local-backup-scanner';
import { LocalBackupManifestStore } from './local-backup-manifest';
import { LocalBackupCopier } from './local-backup-copier';
import { LocalBackupPruner } from './local-backup-pruner';
import { LocalBackupRestorer } from './local-backup-restorer';

// 运行态共享类型定义于 ./types，此处重导出保持 backup/index.ts 公共 API 不变
export type {
  LocalBackupCompression,
  LocalBackupFileEntry,
  LocalBackupManifest,
  LocalBackupRestoreResult,
};

/** 快照条目名（ISO 时间戳目录或同名 .zip）；不匹配的条目（pre-restore-*、MANIFEST.json 等）不参与轮换 */
const SNAPSHOT_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(\.zip)?$/;

/** LocalBackup.runZipBackup 参数对象 */
interface RunZipBackupParams {
  resolvedBackupDir: string;
  snapshotName: string;
  files: string[];
  projectPath: string;
  timestamp: string;
  config: LocalBackupConfig;
  abortSignal?: AbortSignal;
}

/** LocalBackup.runDirectoryBackup 参数对象 */
interface RunDirectoryBackupParams {
  resolvedBackupDir: string;
  snapshotName: string;
  files: string[];
  manifest: LocalBackupManifest | null;
  projectPath: string;
  timestamp: string;
  config: LocalBackupConfig;
  abortSignal?: AbortSignal;
}

export class LocalBackup {
  private backupRoot: string;
  private readonly scanner: LocalBackupScanner = new LocalBackupScanner();
  private readonly manifestStore: LocalBackupManifestStore = new LocalBackupManifestStore();
  private readonly copier: LocalBackupCopier = new LocalBackupCopier();
  private readonly pruner: LocalBackupPruner = new LocalBackupPruner();
  private readonly restorer: LocalBackupRestorer = new LocalBackupRestorer();

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
      // A3：先清掉上次中断留下的 .zip.tmp（mtime 超过 24h 才算死文件，
      // 正在写的临时文件 mtime 会持续更新），否则它们永远进不了轮换清理
      const staleTmp = await this.pruner.pruneStaleTmpFiles(resolvedBackupDir);
      if (staleTmp.removed.length > 0) {
        console.info(`[backup] 清理 ${staleTmp.removed.length} 份中断残留快照`);
      }
      if (staleTmp.failed.length > 0) {
        console.warn(`[backup] ${staleTmp.failed.length} 份残留快照清理失败`);
      }

      const manifest = await this.manifestStore.loadManifest(resolvedBackupDir);
      const files = await this.scanner.scanFiles(projectPath, config.excludePatterns, abortSignal);
      // P2-6：打包前体积闸门——超限直接失败并给处置提示，不再默默写 1.5GB 快照
      const sizeError = backupSizeLimitError(
        await estimateFilesTotalSize(files),
        config.maxTotalSizeMB,
      );
      if (sizeError) {
        return { type: 'local', success: false, error: sizeError };
      }
      const timestamp = new Date().toISOString();
      const snapshotName = timestamp.replace(/[:.]/g, '-');

      if (config.format === 'zip') {
        return await this.runZipBackup({
          resolvedBackupDir,
          snapshotName,
          files,
          projectPath,
          timestamp,
          config,
          ...(abortSignal !== undefined ? { abortSignal } : {}),
        });
      }
      return await this.runDirectoryBackup({
        resolvedBackupDir,
        snapshotName,
        files,
        manifest,
        projectPath,
        timestamp,
        config,
        ...(abortSignal !== undefined ? { abortSignal } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知本地备份错误';
      return {
        type: 'local',
        success: false,
        error: message,
      };
    }
  }

  /** 解析备份根目录（支持 ~ 前缀展开，展开语义见 @zh/shared 的 expandHome） */
  private resolveBackupDir(config: LocalBackupConfig): string {
    return config.backupDir ? expandHome(config.backupDir) : this.backupRoot;
  }

  /** zip 格式备份：构建快照归档并轮换旧备份 */
  private async runZipBackup(params: RunZipBackupParams): Promise<LocalBackupSubResult> {
    const { resolvedBackupDir, snapshotName, files, projectPath, timestamp, config, abortSignal } =
      params;
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
      ...(stats.errors > 0 && stats.backedUp === 0
        ? { error: `${stats.errors} 个文件打包失败` }
        : {}),
    };
  }

  /** 目录格式备份：增量复制文件、写清单并轮换旧备份 */
  private async runDirectoryBackup(
    params: RunDirectoryBackupParams,
  ): Promise<LocalBackupSubResult> {
    const {
      resolvedBackupDir,
      snapshotName,
      files,
      manifest,
      projectPath,
      timestamp,
      config,
      abortSignal,
    } = params;
    const backupDir = safeJoinReal(resolvedBackupDir, snapshotName);
    const isFullBackup = !manifest || manifest.files.length === 0;
    const { backedUp, errors, totalSize, fileEntries } = await this.copier.copyChangedFiles({
      files,
      _manifest: manifest,
      _isFullBackup: isFullBackup,
      backupDir,
      projectPath,
      timestamp,
      ...(abortSignal !== undefined ? { abortSignal } : {}),
      compress: config.compress,
    });

    if (!abortSignal?.aborted) {
      await this.manifestStore.writeManifest(backupDir, timestamp, isFullBackup, fileEntries);
      await this.manifestStore.updateManifestFile(
        resolvedBackupDir,
        fileEntries,
        timestamp,
        isFullBackup,
      );
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
        if (entry === 'node_modules') continue;
        if (!SNAPSHOT_NAME_RE.test(entry)) continue;
        const fullPath = path.join(dir, entry);
        // perf rule false positive: arg depends on loop var via dataflow
        // eslint-disable-next-line perf/perf-no-serial-await
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
    const { failed } = await this.pruner.pruneOldBackups(dirs, maxBackups);
    if (failed.length > 0) {
      console.warn(`[backup] ${failed.length} 个旧备份清理失败（可能被占用）`);
    }
  }
}
