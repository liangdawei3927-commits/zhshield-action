/**
 * 一键备份系统 IPC（ipc/backup.ts）
 *
 * 前端备份页通过 window.electronAPI.backup.* 调用，主进程在此实例化
 * @zh/kernel 的 BackupOrchestrator 执行 GitHub / 本地备份。
 * 备份记录持久化到 <userData>/backup-records.json，重启应用后仍可查看历史记录。
 *
 * 按功能域拆分：记录持久化见 backup-records.ts，打开备份目录见 backup-open.ts，
 * 定时调度见 backup-schedule.ts，健康快照见 backup-health.ts。本文件只保留
 * IPC 处理器注册与启动装配；下方 re-export 保持原公开符号路径不变。
 */
import { ipcMain } from 'electron';
import { t } from '@zh/i18n';
import {
  BackupOrchestrator,
  BackupConfigManager,
  BACKUP_EVENTS,
  defaultBackupConfig,
  type BackupConfig,
} from '@zh/kernel';
import { eventBus, getMainWindow } from '../ipc-context';
import {
  loadRecordsFromDisk,
  persistRecords,
  serializeResult,
  type SerializedBackupResult,
  type KernelBackupRecord,
} from './backup-records';
import { openBackupFolder } from './backup-open';
import {
  setupScheduledBackups,
  syncProjectSchedule,
} from './backup-schedule';

// ─── 兼容再导出：拆分后原公开符号路径保持不变（测试与 engines-scoring 按此引用）───
export { openBackupFolder, isInsideBackupRoots } from './backup-open';
export { minuteKey, createScheduleRunner, syncProjectSchedule } from './backup-schedule';
export type { ScheduleSyncDeps } from './backup-schedule';
export {
  buildBackupHealthSnapshot,
  isSameProjectPath,
  loadBackupHealthSnapshot,
} from './backup-health';
export type { BackupHealthSnapshot, BackupRecordLike } from './backup-health';

/** 前端 BackupConfigData 形状（含 cloud 字段；kernel 配置不含 cloud，返回默认值） */
interface BackupConfigDataShape {
  cloud: { enabled: boolean; serverUrl: string; [key: string]: unknown };
  github: BackupConfig['github'];
  local: BackupConfig['local'];
  schedule: BackupConfig['schedule'];
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

/**
 * 进行中的手动备份 → 取消句柄。
 *
 * kernel 的备份链路（扫描 / 复制 / 打包 / GitHub 请求）**本就支持 abortSignal**，
 * 但此前没有任何调用方传它 ⇒ 用户点下「一键备份」就只能等它跑完。这里把句柄接上，
 * 「停止」才有真实落点（而不是 UI 上假装停了、后台还在写盘）。
 *
 * 只管手动备份：定时备份走 scheduler 直连 orchestrator，不经本句柄。
 */
const runningBackups = new Map<string, AbortController>();

function registerExecuteHandler(orchestrator: BackupOrchestrator): void {
  ipcMain.handle(
    'backup:execute',
    async (_event, projectPath: string, trigger?: string): Promise<SerializedBackupResult> => {
      if (!projectPath || typeof projectPath !== 'string') {
        throw new Error(t('electron.invalidProjectPath'));
      }
      const controller = new AbortController();
      runningBackups.set(projectPath, controller);
      try {
        const result = await orchestrator.execute({
          projectId: projectPath,
          projectPath,
          trigger: trigger === 'schedule' || trigger === 'api' ? trigger : 'manual',
          abortSignal: controller.signal,
        });
        await persistRecords(orchestrator);
        return serializeResult(result);
      } finally {
        runningBackups.delete(projectPath);
      }
    },
  );
}

/** 停止进行中的备份：abort 交给 kernel 的检查点，未跑完的 zip/清单不会落盘 */
function registerCancelHandler(): void {
  ipcMain.handle(
    'backup:cancel',
    async (_event, projectPath: string): Promise<{ ok: boolean; cancelled: boolean }> => {
      if (!projectPath || typeof projectPath !== 'string') return { ok: false, cancelled: false };
      const controller = runningBackups.get(projectPath);
      if (!controller) {
        // 没有在跑的备份：如实说没取消成什么，不粉饰成"已停止"
        return { ok: true, cancelled: false };
      }
      controller.abort();
      return { ok: true, cancelled: true };
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
        return toConfigData(defaultBackupConfig());
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
  ipcMain.handle(
    'backup:openFolder',
    async (_event, projectPath: string, folderPath: string): Promise<boolean> => {
      return openBackupFolder(projectPath, folderPath);
    },
  );
}

/** eventBus 接通：备份进度/完成/失败事件转发到渲染层（此前未传 eventBus，大包期间 UI 零反馈） */
function wireBackupEventBus(): void {
  const forwardToRenderer = (channel: string) => (payload: unknown) => {
    getMainWindow()?.webContents.send(channel, payload);
  };
  eventBus.on(BACKUP_EVENTS.STARTED, forwardToRenderer('backup:started'));
  eventBus.on(BACKUP_EVENTS.PROGRESS, forwardToRenderer('backup:progress'));
  eventBus.on(BACKUP_EVENTS.COMPLETED, forwardToRenderer('backup:completed'));
  eventBus.on(BACKUP_EVENTS.FAILED, forwardToRenderer('backup:failed'));
}

/** 启动时加载历史记录，保证重启后记录列表仍可读（异步读取，不阻塞主进程启动） */
function loadHistoricalRecords(orchestrator: BackupOrchestrator): void {
  void loadRecordsFromDisk()
    .then((records) => orchestrator.loadRecords(records))
    .catch((err) => {
      console.warn('[backup] 历史记录加载失败:', err instanceof Error ? err.message : String(err));
    });
}

export function registerBackupIpc(): void {
  const configManager = new BackupConfigManager();
  const orchestrator = new BackupOrchestrator({ configManager, eventBus });
  wireBackupEventBus();
  const scheduleDeps = setupScheduledBackups(configManager, orchestrator);
  loadHistoricalRecords(orchestrator);
  registerExecuteHandler(orchestrator);
  registerCancelHandler();
  registerRecordsHandler(orchestrator);
  registerRecordHandler(orchestrator);
  registerDeleteRecordHandler(orchestrator);
  registerConfigHandlers(configManager, (projectPath) =>
    syncProjectSchedule(scheduleDeps, projectPath),
  );
  registerAuthorizeHandler();
  registerOpenFolderHandler();
}
