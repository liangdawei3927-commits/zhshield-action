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
  defaultBackupConfig,
  type BackupConfig,
} from '@zh/kernel';

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

function registerConfigHandlers(configManager: BackupConfigManager): void {
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

export function registerBackupIpc(): void {
  const configManager = new BackupConfigManager();
  const orchestrator = new BackupOrchestrator({ configManager });

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
  registerConfigHandlers(configManager);
  registerAuthorizeHandler();
  registerOpenFolderHandler();
}
