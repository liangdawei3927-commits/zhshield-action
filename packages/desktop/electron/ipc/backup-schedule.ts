/**
 * 定时备份调度（从 ipc/backup.ts 按功能域拆出）
 *
 * BackupScheduler 接线：同分钟去重、cron 注册/注销、启动时全量同步。
 */
import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BackupConfigManager,
  BackupOrchestrator,
  BackupScheduler,
  type BackupScheduleConfig,
} from '@zh/kernel';
import { getMainWindow } from '../ipc-context';
import { loadRecordsFromDisk, persistRecords } from './backup-records';
import { isSameProjectPath } from './backup-health';

/** 同一分钟内只允许触发一次：调度器每分钟 tick，同分钟双 tick 会重复执行备份 */
export function minuteKey(nowMs: number): number {
  return Math.floor(nowMs / 60_000);
}

/** 创建带同分钟去重的调度回调。execute 抛错只记录日志，不让调度器崩溃 */
export function createScheduleRunner(execute: (projectPath: string) => Promise<unknown>): {
  run: (projectPath: string) => Promise<void>;
  lastRunMinute: Map<string, number>;
} {
  const lastRunMinute = new Map<string, number>();
  const run = async (projectPath: string): Promise<void> => {
    const key = minuteKey(Date.now());
    if (lastRunMinute.get(projectPath) === key) return;
    lastRunMinute.set(projectPath, key);
    try {
      await execute(projectPath);
    } catch (err) {
      console.warn('[backup] 定时备份执行失败:', err instanceof Error ? err.message : String(err));
    }
  };
  return { run, lastRunMinute };
}

/** syncProjectSchedule 的依赖注入集合：调度器、配置读取与备份执行 */
export interface ScheduleSyncDeps {
  scheduler: Pick<BackupScheduler, 'registerSchedule' | 'unregisterSchedule'>;
  loadScheduleConfig: (projectPath: string) => Promise<BackupScheduleConfig>;
  runBackup: (projectPath: string) => Promise<void>;
  /**
   * 该项目最近一次成功备份的 epoch ms（供调度器做错过补跑判定）。
   * 返回 undefined = 从未成功备份，此时调度器不补跑。
   */
  loadLastRunAt?: (projectPath: string) => Promise<number | undefined>;
}

/** 读取项目备份配置，启用则注册 cron 任务、禁用则注销（saveConfig 后即时同步也走这里） */
export async function syncProjectSchedule(
  deps: ScheduleSyncDeps,
  projectPath: string,
): Promise<void> {
  try {
    const schedule = await deps.loadScheduleConfig(projectPath);
    if (schedule?.enabled) {
      // 补跑判定数据：App 不在线期间错过的调度，在启动注册时立即补一次
      const lastRunAt = deps.loadLastRunAt ? await deps.loadLastRunAt(projectPath) : undefined;
      await deps.scheduler.registerSchedule(projectPath, schedule, () =>
        deps.runBackup(projectPath),
        { lastRunAt },
      );
    } else {
      deps.scheduler.unregisterSchedule(projectPath);
    }
  } catch (err) {
    console.warn(
      '[backup] 定时任务同步失败:',
      projectPath,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** 从 <userData>/projects.json 读取已添加项目路径；文件不存在返回空数组 */
async function loadProjectPaths(): Promise<string[]> {
  try {
    const file = join(app.getPath('userData'), 'projects.json');
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as Array<{ path?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p) => p?.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

/** 定时备份：启动时按各项目 backup.yml 注册任务 */
export function setupScheduledBackups(
  configManager: BackupConfigManager,
  orchestrator: BackupOrchestrator,
): ScheduleSyncDeps {
  const scheduler = new BackupScheduler();
  const { run: runScheduledBackup } = createScheduleRunner(async (projectPath) => {
    const result = await orchestrator.execute({
      projectId: projectPath,
      projectPath,
      trigger: 'schedule',
    });
    await persistRecords(orchestrator);
    // 通知渲染层记录已更新（用户可能在别的页面，回来时能看到定时备份结果）
    getMainWindow()?.webContents.send('backup:records-updated', {
      projectId: projectPath,
      status: result.overallStatus,
    });
  });
  const scheduleDeps: ScheduleSyncDeps = {
    scheduler,
    loadScheduleConfig: async (projectPath) => {
      const config = await configManager.loadProjectConfig(projectPath);
      return config.schedule;
    },
    runBackup: runScheduledBackup,
    loadLastRunAt: async (projectPath) => {
      try {
        const records = await loadRecordsFromDisk();
        const own = records
          .filter(
            (r) => isSameProjectPath(r.projectId, projectPath) && r.status === 'success',
          )
          .map((r) => Date.parse(r.timestamp))
          .filter((t) => Number.isFinite(t));
        return own.length ? Math.max(...own) : undefined;
      } catch {
        return undefined;
      }
    },
  };
  const syncAllSchedules = async (): Promise<void> => {
    const paths = await loadProjectPaths();
    for (const p of paths) {
      await syncProjectSchedule(scheduleDeps, p);
    }
    scheduler.start();
  };
  void syncAllSchedules().catch((err) => {
    console.warn('[backup] 定时备份初始化失败:', err instanceof Error ? err.message : String(err));
  });
  return scheduleDeps;
}
