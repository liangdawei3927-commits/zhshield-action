/**
 * 一键备份系统 — 旧备份轮换清理
 *
 * 从 LocalBackup 拆出，保持单类行数与职责可控。
 *
 * **这是全仓唯一的备份删除入口**（`BackupManager.pruneOldBackups` 已改为委托到此），
 * 因此「至少保留最新 1 份」的护栏只需在这里守一次 —— 见 `retention.ts`。
 */
import * as fs from 'node:fs/promises';
import { normalizeKeepCount } from './retention';

export interface BackupPruneOutcome {
  /** 实际删除的旧备份路径（`dirs` 为新→旧排序时，即保留之外的尾部） */
  removed: string[];
  /** 删除失败的路径 —— 不阻断备份流程，但必须可见，不允许静默吞掉 */
  failed: string[];
}

export class LocalBackupPruner {
  /**
   * 轮换清理。
   *
   * @param dirs 备份条目，必须按 **新→旧** 排序（`listBackups()` 的约定）
   * @param maxBackups 期望保留份数；经 `normalizeKeepCount` 规范化，
   *   **任何取值下都至少保留最新 1 份**
   */
  async pruneOldBackups(dirs: string[], maxBackups: number): Promise<BackupPruneOutcome> {
    const keep = normalizeKeepCount(maxBackups);
    const outcome: BackupPruneOutcome = { removed: [], failed: [] };
    if (dirs.length <= keep) return outcome;

    for (const dir of dirs.slice(keep)) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        outcome.removed.push(dir);
      } catch {
        outcome.failed.push(dir);
      }
    }
    return outcome;
  }
}
