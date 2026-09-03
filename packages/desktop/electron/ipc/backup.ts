/**
 * 一键备份系统 IPC（ipc/backup.ts）
 *
 * 前端备份页通过 window.electronAPI.backup.* 调用，主进程在此实例化
 * @zh/kernel 的 BackupOrchestrator 执行 GitHub / 本地备份。
 * 备份记录持久化到 <userData>/backup-records.json，重启应用后仍可查看历史记录。
 */
import { app, ipcMain } from 'electron';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from '@zh/i18n';
import {
  BackupOrchestrator,
  BackupConfigManager,
  BackupScheduler,
  BACKUP_EVENTS,
  defaultBackupConfig,
  type BackupConfig,
  type BackupScheduleConfig,
} from '@zh/kernel';
import { eventBus, getMainWindow } from '../ipc-context';

// @zh/kernel 顶层同时导出旧版增量备份与新版一键备份的 BackupResult/BackupRecord，
// 显式命名导出优先导致顶层类型指向旧版。此处从实例方法签名推导，避免命名冲突。
type KernelBackupResult = Awaited<ReturnType<BackupOrchestrator['execute']>>;
type KernelBackupRecord = ReturnType<BackupOrchestrator['getRecords']>[number];

/** 序列化后的备份结果（kernel 的 timestamp 为 Date，IPC 传输需转 ISO 字符串） */
interface SerializedBackupResult {
  projectId: string;
  projectName: string;
  trigger: string;
  overallStatus: string;
  timestamp: string;
  duration: number;
  error?: string;
  results: Array<Record<string, unknown>>;
}

/** 前端 BackupConfigData 形状（含 cloud 字段；kernel 配置不含 cloud，返回默认值） */
interface BackupConfigDataShape {
  cloud: { enabled: boolean; serverUrl: string; [key: string]: unknown };
  github: BackupConfig['github'];
  local: BackupConfig['local'];
  schedule: BackupConfig['schedule'];
}

const RECORDS_FILE = 'backup-records.json';
const MAX_RECORDS = 100;

function recordsPath(): string {
  return join(app.getPath('userData'), RECORDS_FILE);
}

/** 读取持久化的备份记录；文件不存在或损坏时返回空数组 */
async function loadRecordsFromDisk(): Promise<KernelBackupRecord[]> {
  const file = recordsPath();
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown;
    return Array.isArray(parsed) ? (parsed as KernelBackupRecord[]) : [];
  } catch (err) {
    console.warn('[backup] 历史记录解析失败:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** 将当前内存中的记录持久化到磁盘（仅保留最近 MAX_RECORDS 条） */
async function persistRecords(orchestrator: BackupOrchestrator): Promise<void> {
  try {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(
      recordsPath(),
      JSON.stringify(orchestrator.getRecords().slice(0, MAX_RECORDS), null, 2),
      'utf-8',
    );
  } catch (err) {
    console.warn('[backup] 记录持久化失败:', err instanceof Error ? err.message : String(err));
  }
}

function serializeResult(result: KernelBackupResult): SerializedBackupResult {
  return {
    projectId: result.projectId,
    projectName: result.projectName,
    trigger: result.trigger,
    overallStatus: result.overallStatus,
    timestamp: result.timestamp.toISOString(),
    duration: result.duration,
    ...(result.error ? { error: result.error } : {}),
    results: result.results as unknown as Array<Record<string, unknown>>,
  };
}

function toConfigData(config: BackupConfig): BackupConfigDataShape {
  return {
    cloud: { enabled: false, serverUrl: '' },
    github: config.github,
    local: config.local,
    schedule: config.schedule,
  };
}

function fromConfigData(data: Record<string, unknown>, projectPath?: string): BackupConfig {
  const def = defaultBackupConfig(projectPath ? { projectPath } : undefined);
  const github = data.github as Partial<BackupConfig['github']> | undefined;
  const local = data.local as Partial<BackupConfig['local']> | undefined;
  const schedule = data.schedule as Partial<BackupConfig['schedule']> | undefined;
  return {
    github: { ...def.github, ...github },
    local: { ...def.local, ...local },
    schedule: { ...def.schedule, ...schedule },
  };
}

function registerExecuteHandler(orchestrator: BackupOrchestrator): void {
  ipcMain.handle(
    'backup:execute',
    async (_event, projectPath: string, trigger?: string): Promise<SerializedBackupResult> => {
      if (!projectPath || typeof projectPath !== 'string') {
        throw new Error(t('electron.invalidProjectPath'));
      }
      const result = await orchestrator.execute({
        projectId: projectPath,
        projectPath,
        trigger: trigger === 'schedule' || trigger === 'api' ? trigger : 'manual',
      });
      await persistRecords(orchestrator);
      return serializeResult(result);
    },
  );
}

function registerRecordsHandler(orchestrator: BackupOrchestrator): void {
  ipcMain.handle('backup:records', (_event, projectId?: string): KernelBackupRecord[] => {
    if (projectId && typeof projectId === 'string') {
      return orchestrator.getRecords(projectId);
    }
    return orchestrator.getRecords();
  });
}

function registerRecordHandler(orchestrator: BackupOrchestrator): void {
  ipcMain.handle('backup:record', (_event, recordId: string): KernelBackupRecord | null => {
    if (!recordId || typeof recordId !== 'string') return null;
    return orchestrator.getRecord(recordId) ?? null;
  });
}

function registerDeleteRecordHandler(orchestrator: BackupOrchestrator): void {
  ipcMain.handle('backup:deleteRecord', async (_event, recordId: string): Promise<boolean> => {
    if (!recordId || typeof recordId !== 'string') return false;
    const ok = orchestrator.deleteRecord(recordId);
    if (ok) await persistRecords(orchestrator);
    return ok;
  });
}

function registerConfigHandlers(
  configManager: BackupConfigManager,
  onConfigSaved?: (projectPath: string) => Promise<void>,
): void {
  ipcMain.handle(
    'backup:getConfig',
    async (_event, projectPath: string): Promise<BackupConfigDataShape> => {
      if (!projectPath || typeof projectPath !== 'string') {
        return {
          cloud: { enabled: false, serverUrl: '' },
          github: {},
          local: {},
          schedule: {},
        } as unknown as BackupConfigDataShape;
      }
      return toConfigData(await configManager.loadProjectConfig(projectPath));
    },
  );

  ipcMain.handle(
    'backup:saveConfig',
    async (_event, projectPath: string, config: Record<string, unknown>): Promise<void> => {
      if (!projectPath || typeof projectPath !== 'string' || !config || typeof config !== 'object')
        return;
      await configManager.saveProjectConfig(projectPath, fromConfigData(config, projectPath));
      // 配置变更后同步定时任务注册（启用/禁用/改时间都即时生效，无需重启应用）
      await onConfigSaved?.(projectPath);
    },
  );
}

// GitHub OAuth 授权流程由桌面端内嵌授权页承接，IPC 仅返回状态
function registerAuthorizeHandler(): void {
  ipcMain.handle('backup:authorizeGitHub', (): boolean => false);
}

function registerOpenFolderHandler(): void {
  ipcMain.handle('backup:openFolder', async (_event, folderPath: string): Promise<boolean> => {
    if (!folderPath || typeof folderPath !== 'string') return false;
    const { shell } = await import('electron');
    const { homedir } = await import('node:os');

    // 快照目录可能已被 maxBackups 轮换清理：回退打开其所在备份根目录，保证“查看备份”仍可用
    let target = folderPath.startsWith('~') ? join(homedir(), folderPath.slice(1)) : folderPath;
    try {
      await stat(target);
    } catch {
      const parent = join(target, '..');
      try {
        await stat(parent);
      } catch {
        return false;
      }
      target = parent;
    }

    // zip 归档快照是文件而非目录：在 Finder 中高亮显示，避免 openPath 触发解压
    if ((await stat(target)).isFile()) {
      shell.showItemInFolder(target);
      return true;
    }

    // shell.openPath 失败不抛异常而是 resolve 错误字符串，必须检查返回值而非 try/catch
    const errMsg = await shell.openPath(target);
    return !errMsg;
  });
}

// ─── 定时备份调度（此前 BackupScheduler 是死代码，从未接线）──────

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

export interface ScheduleSyncDeps {
  scheduler: Pick<BackupScheduler, 'registerSchedule' | 'unregisterSchedule'>;
  loadScheduleConfig: (projectPath: string) => Promise<BackupScheduleConfig>;
  runBackup: (projectPath: string) => Promise<void>;
}

/** 读取项目备份配置，启用则注册 cron 任务、禁用则注销（saveConfig 后即时同步也走这里） */
export async function syncProjectSchedule(
  deps: ScheduleSyncDeps,
  projectPath: string,
): Promise<void> {
  try {
    const schedule = await deps.loadScheduleConfig(projectPath);
    if (schedule?.enabled) {
      await deps.scheduler.registerSchedule(projectPath, schedule, () =>
        deps.runBackup(projectPath),
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

export function registerBackupIpc(): void {
  const configManager = new BackupConfigManager();
  // eventBus 接通：备份进度/完成/失败事件转发到渲染层（此前未传 eventBus，大包期间 UI 零反馈）
  const orchestrator = new BackupOrchestrator({ configManager, eventBus });
  const forwardToRenderer = (channel: string) => (payload: unknown) => {
    getMainWindow()?.webContents.send(channel, payload);
  };
  eventBus.on(BACKUP_EVENTS.STARTED, forwardToRenderer('backup:started'));
  eventBus.on(BACKUP_EVENTS.PROGRESS, forwardToRenderer('backup:progress'));
  eventBus.on(BACKUP_EVENTS.COMPLETED, forwardToRenderer('backup:completed'));
  eventBus.on(BACKUP_EVENTS.FAILED, forwardToRenderer('backup:failed'));

  // ─── 定时备份：启动时按各项目 backup.yml 注册任务 ─────────
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

  // 启动时加载历史记录，保证重启后记录列表仍可读（异步读取，不阻塞主进程启动）
  void loadRecordsFromDisk()
    .then((records) => orchestrator.loadRecords(records))
    .catch((err) => {
      console.warn('[backup] 历史记录加载失败:', err instanceof Error ? err.message : String(err));
    });

  registerExecuteHandler(orchestrator);
  registerRecordsHandler(orchestrator);
  registerRecordHandler(orchestrator);
  registerDeleteRecordHandler(orchestrator);
  registerConfigHandlers(configManager, (projectPath) =>
    syncProjectSchedule(scheduleDeps, projectPath),
  );
  registerAuthorizeHandler();
  registerOpenFolderHandler();
}
