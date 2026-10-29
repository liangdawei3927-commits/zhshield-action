/**
 * 备份健康快照（从 ipc/backup.ts 按功能域拆出）
 *
 * 十域评分章程 #10，报告中心汇总只读消费。
 * 纯聚合函数不依赖 Electron/磁盘；磁盘读取集中在 loadBackupHealthSnapshot。
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { BackupConfigManager } from '@zh/kernel';
import { loadRecordsFromDisk } from './backup-records';

/** 备份健康快照：供 buildPipelineExtras 组装 @zh/scoring 的 BackupDataLike */
export interface BackupHealthSnapshot {
  /** 最近一次成功备份时间（ISO）；null = 从未成功 */
  lastSuccessAt: string | null;
  /** 最近 ≤10 条记录的 overallStatus（新→旧）：success / partial / failed */
  recentStatuses: string[];
  /** 是否启用了定时备份 */
  scheduleEnabled: boolean;
}

/**
 * 持久化备份记录的最小形状（与 @zh/kernel BackupRecord 字段契约对齐；
 * status 为唯一状态字段，见 kernel/src/backup/types.ts BackupRecord）。
 */
export interface BackupRecordLike {
  projectId: string;
  timestamp: string;
  status: string;
}

/**
 * 由原始备份记录聚合健康快照（纯函数，不依赖 Electron/磁盘）。
 * 传入 null = 该项目从未备份且未启用定时备份（评分侧按 not-run 处理）。
 */
export function buildBackupHealthSnapshot(
  records: BackupRecordLike[],
  scheduleEnabled: boolean,
): BackupHealthSnapshot | null {
  const own = records
    .filter((r) => Number.isFinite(new Date(r.timestamp).getTime()))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  if (own.length === 0 && !scheduleEnabled) return null;

  const lastSuccess = own.find((r) => r.status === 'success');
  return {
    lastSuccessAt: lastSuccess ? new Date(lastSuccess.timestamp).toISOString() : null,
    recentStatuses: own.slice(0, 10).map((r) => r.status),
    scheduleEnabled,
  };
}

/**
 * 项目路径同一性判定（备份记录匹配用）。
 *
 * backup-records 的 projectId 落盘的是添加项目时的原始路径字符串，macOS 上
 * `/tmp/x` 与 `/private/tmp/x` 是同一目录（symlink），字面相等会把同一项目
 * 误判成两个——后果是备份补跑判定静默失配（该补没补且无人知晓，正是
 * cc84d13 要治的故障形态的同族复发）。两侧先 realpath 归一再比较；
 * 路径已不存在时（realpath 抛错）退 resolve，至少消除尾斜杠/相对段差异。
 */
export function isSameProjectPath(
  a: string,
  b: string,
  realpathFn: (p: string) => string = realpathSync,
): boolean {
  if (a === b) return true;
  const norm = (p: string): string => {
    try {
      return realpathFn(p);
    } catch {
      return resolve(p);
    }
  };
  return norm(a) === norm(b);
}

/** 读取项目是否启用定时备份（配置读取失败按未启用处理） */
async function isScheduleEnabled(projectPath: string): Promise<boolean> {
  try {
    const config = await new BackupConfigManager().loadProjectConfig(projectPath);
    return config?.schedule?.enabled === true;
  } catch {
    return false;
  }
}

/** 只读指定项目的备份健康快照（从磁盘记录 + 项目配置聚合，不触发任何备份）。 */
export async function loadBackupHealthSnapshot(
  projectPath: string,
): Promise<BackupHealthSnapshot | null> {
  try {
    const records = await loadRecordsFromDisk();
    const own = records.filter((r) => isSameProjectPath(r.projectId, projectPath));
    const scheduleEnabled = await isScheduleEnabled(projectPath);
    return buildBackupHealthSnapshot(own, scheduleEnabled);
  } catch (err) {
    console.warn(
      '[backup] 健康快照读取失败（按 not-run 处理）:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
