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
import type { LocalBackupFileEntry, LocalBackupManifest } from './local-backup';
import { hashFile } from './utils';
import { safeJoinReal } from '@zh/shared';

export class LocalBackupCopier {
  /**
   * 复制文件到备份目录，返回备份统计与文件清单。
   * 当前实现为每次全量复制，保证单个备份目录自包含、可直接恢复。
   */
  async copyChangedFiles(
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
        const targetPath = safeJoinReal(backupDir, storedAs);
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
