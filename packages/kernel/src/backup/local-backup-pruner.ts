/**
 * 一键备份系统 — 旧备份轮换清理
 *
 * 从 LocalBackup 拆出，保持单类行数与职责可控。
 */
import * as fs from 'node:fs/promises';

export class LocalBackupPruner {
  async pruneOldBackups(dirs: string[], maxBackups: number): Promise<void> {
    if (dirs.length <= maxBackups) return;

    const toRemove = dirs.slice(maxBackups);
    for (const dir of toRemove) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
