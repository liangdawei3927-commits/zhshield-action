/**
 * 一键备份系统 — 目录格式备份的还原（逐条还原 + 失败聚合）
 *
 * 从 LocalBackup 拆出，保持单类行数与职责可控。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  LocalBackupFileEntry,
  LocalBackupManifest,
  LocalBackupRestoreResult,
} from './local-backup';
import { restoreStoredEntry } from './restore-entry';
import { safeJoinReal } from '@zh/shared';

export class LocalBackupRestorer {
  /** 读取目录备份清单中的文件条目 */
  async readManifestFiles(backupPath: string): Promise<LocalBackupFileEntry[]> {
    const manifest = await this.readManifest(backupPath);
    return manifest?.files ?? [];
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

  /** 逐条还原目录备份条目 */
  async restoreDirectoryEntries(
    backupPath: string,
    files: LocalBackupFileEntry[],
    targetDir: string,
    abortSignal?: AbortSignal,
  ): Promise<LocalBackupRestoreResult> {
    let restored = 0;
    let failed = 0;
    const problems: string[] = [];

    for (const entry of files) {
      if (abortSignal?.aborted) break;
      try {
        const targetPath = safeJoinReal(targetDir, entry.relativePath);
        await restoreStoredEntry(backupPath, targetPath, entry);
        restored++;
      } catch (err) {
        failed++;
        problems.push(`${entry.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { restored, failed, problems };
  }
}
