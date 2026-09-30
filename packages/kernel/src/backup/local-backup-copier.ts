/**
 * 一键备份系统 — 目录格式备份的文件复制（hash 记录 + 可选 gzip 压缩）
 *
 * 从 LocalBackup 拆出，保持单类行数与职责可控。
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { LocalBackupFileEntry, LocalBackupManifest } from './types';
import { hashFile } from './utils';
import { safeJoinReal } from '@zh/shared';

/** LocalBackupCopier.copyChangedFiles 参数对象 */
export interface CopyChangedFilesParams {
  files: string[];
  _manifest: LocalBackupManifest | null;
  _isFullBackup: boolean;
  backupDir: string;
  projectPath: string;
  timestamp: string;
  abortSignal?: AbortSignal;
  compress?: boolean;
}

export class LocalBackupCopier {
  /**
   * 复制文件到备份目录，返回备份统计与文件清单。
   * 当前实现为每次全量复制，保证单个备份目录自包含、可直接恢复。
   */
  async copyChangedFiles(params: CopyChangedFilesParams): Promise<{
    backedUp: number;
    errors: number;
    totalSize: number;
    fileEntries: LocalBackupFileEntry[];
  }> {
    const { files, backupDir, projectPath, timestamp, abortSignal, compress } = params;
    const fileEntries: LocalBackupFileEntry[] = [];
    let backedUp = 0;
    let errors = 0;
    let totalSize = 0;

    for (const file of files) {
      if (abortSignal?.aborted) break;
      const entry = await copySingleFile(file, { backupDir, projectPath, timestamp, compress });
      if (entry === null) {
        errors++;
        continue;
      }
      fileEntries.push(entry);
      totalSize += entry.size;
      backedUp++;
    }

    return { backedUp, errors, totalSize, fileEntries };
  }
}

async function copySingleFile(
  file: string,
  opts: { backupDir: string; projectPath: string; timestamp: string; compress?: boolean },
): Promise<LocalBackupFileEntry | null> {
  const relativePath = path.relative(opts.projectPath, file);
  try {
    const [hash, stat] = await Promise.all([hashFile(file), fs.stat(file)]);
    const storedAs = opts.compress ? `${relativePath}.gz` : relativePath;
    const targetPath = safeJoinReal(opts.backupDir, storedAs);
    // perf rule false positive: arg depends on loop var via dataflow
    // eslint-disable-next-line perf/perf-no-serial-await
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (opts.compress) {
      await pipeline(
        fsSync.createReadStream(file),
        createGzip(),
        fsSync.createWriteStream(targetPath),
      );
    } else {
      await fs.cp(file, targetPath, { preserveTimestamps: true });
    }
    return {
      relativePath,
      hash,
      size: stat.size,
      backedUpAt: opts.timestamp,
      storedAs,
      compression: opts.compress ? 'gzip' : 'none',
    };
  } catch {
    return null;
  }
}
