/**
 * 一键备份系统 — 旧备份轮换清理
 *
 * 从 LocalBackup 拆出，保持单类行数与职责可控。
 *
 * **这是全仓唯一的备份删除入口**（`BackupManager.pruneOldBackups` 已改为委托到此），
 * 因此「至少保留最新 1 份」的护栏只需在这里守一次 —— 见 `retention.ts`。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeKeepCount } from './retention';

/** 中断残留的临时快照后缀（`buildZipSnapshot` 先写 `<name>.zip.tmp` 再原子改名） */
const TMP_SNAPSHOT_SUFFIX = '.zip.tmp';

/**
 * 临时快照默认保留时长：24 小时。
 *
 * 为什么不「存在即删」：正在进行的备份会让 mtime 持续更新（10-25 那次 1.17GB
 * 写了 8 小时），按存在即删会删掉正在写的归档。24h 的余量足够覆盖最慢的一次
 * 完整备份，同时保证每天失败也只堆积 1 份。
 */
export const DEFAULT_TMP_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

/** 备份轮换清理结果：成功删除与删除失败两路路径分开上报 */
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

  /**
   * 清理失败中断留下的临时快照（`*.zip.tmp`）。
   *
   * 为什么必须单独清：`LocalBackup.listBackups` 的 `SNAPSHOT_NAME_RE` 只匹配
   * 完整快照名（`<iso>.zip` / `<iso>/`），`.zip.tmp` 永远进不了上面那条轮换
   * 清理 —— 结果是每次写盘中断就永久留下一份几百 MB～1GB 的死文件
   * （2026-10-27 实测本机堆了 5 份共约 3.3GB，备份目录涨到 13GB）。
   *
   * 判据是 **mtime 超过 ttl**，不是「存在即删」：正在写的临时文件 mtime 会
   * 持续更新，按存在即删会毁掉进行中的备份。
   */
  async pruneStaleTmpFiles(
    backupRoot: string,
    ttlMs: number = DEFAULT_TMP_SNAPSHOT_TTL_MS,
    now: number = Date.now(),
  ): Promise<BackupPruneOutcome> {
    const outcome: BackupPruneOutcome = { removed: [], failed: [] };
    let entries: string[];
    try {
      entries = await fs.readdir(backupRoot);
    } catch {
      // 目录还不存在（首次备份）——无事可清
      return outcome;
    }
    // 语境说明（perf/perf-walk-requires-ignore 豁免）：backupRoot 是备份存放目录，
    // 只含 `<iso>.zip` / `<iso>/` 快照与 `.zip.tmp` 残片，是平坦单层结构，
    // 不存在也不可能出现 node_modules；walk-ignore 的「递归遍历须跳过
    // node_modules」前提在此不成立，故不做无效的跳过分支。
    // stat/rm 并行：条目互相独立，成果/失败分桶在各自回调内完成，与串行语义一致。
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.endsWith(TMP_SNAPSHOT_SUFFIX)) return;
        const fullPath = path.join(backupRoot, entry);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat === null) return;
        // 未来时间（时钟回拨）按新鲜处理，宁可留着也不误删
        if (now - stat.mtimeMs < ttlMs) return;
        try {
          await fs.rm(fullPath, { force: true });
          outcome.removed.push(fullPath);
        } catch {
          outcome.failed.push(fullPath);
        }
      }),
    );
    return outcome;
  }
}
