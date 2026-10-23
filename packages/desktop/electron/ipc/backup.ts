/**
 * 一键备份系统 IPC（ipc/backup.ts）
 *
 * 前端备份页通过 window.electronAPI.backup.* 调用，主进程在此实例化
 * @zh/kernel 的 BackupOrchestrator 执行 GitHub / 本地备份。
 * 备份记录持久化到 <userData>/backup-records.json，重启应用后仍可查看历史记录。
 */
import { app, ipcMain } from 'electron';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expandHome, safeResolveReal } from '@zh/shared';
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
import { DEFAULT_BACKUP_ROOT } from '@zh/kernel';
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
    results: result.results.map((r) => ({ ...r })),
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

/** 解析打开目标：快照目录可能已被 maxBackups 轮换清理，回退到其所在备份根目录 */
async function resolveOpenTarget(folderPath: string): Promise<string | null> {
  let target = expandHome(folderPath);
  try {
    await stat(target);
  } catch {
    const parent = join(target, '..');
    try {
      await stat(parent);
    } catch {
      return null;
    }
    target = parent;
  }
  return target;
}

/** zip 归档快照是文件而非目录：在 Finder 中高亮显示，避免 openPath 触发解压 */
async function revealOrOpenTarget(target: string): Promise<boolean> {
  const { shell } = await import('electron');
  if ((await stat(target)).isFile()) {
    shell.showItemInFolder(target);
    return true;
  }
  // shell.openPath 失败不抛异常而是 resolve 错误字符串，必须检查返回值而非 try/catch
  const errMsg = await shell.openPath(target);
  return !errMsg;
}

/**
 * 解析该项目的备份根目录（含向上回退，用于定位被轮转清理掉的快照所在根）。
 *
 * 渲染层传来的 folderPath 完全不可信：它逐字取自 <userData>/backup-records.json，
 * 该文件只被 JSON.parse 而无任何校验。篡改该文件即可让一次点击把 Finder 指向
 * 任意绝对路径，因此开目录前必须确认目标仍落在备份根内。
 */
async function resolveBackupRoots(projectPath: string): Promise<string[]> {
  const roots = new Set<string>();
  try {
    const config = await new BackupConfigManager().loadProjectConfig(projectPath);
    // backupDir 是配置里的字面量（形如 `~/zhshield-backups/<project>`），必须先展开 `~`
    // 再 resolve —— 否则根会变成 `<cwd>/~/zhshield-backups/...`，与真实快照路径永不包含。
    if (config?.local?.backupDir) roots.add(resolve(expandHome(config.local.backupDir)));
  } catch {
    /* 配置不可读时下方回退到默认根 */
  }
  roots.add(resolve(expandHome(DEFAULT_BACKUP_ROOT)));
  // 不接纳「根的父级」：快照形如 <root>/<project>/<snapshot>，resolveOpenTarget 的
  // 单层回退目标是 <root>/<project>，本就在根内。若把父级也列为合法根，同级任意
  // 目录（如 /tmp）都会被放行，包含性校验形同虚设。
  return [...roots];
}

/** 目标是否位于任一备份根之内（含符号链接判定，逃逸则拒绝）。导出以便单测直接验证。 */
export function isInsideBackupRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    try {
      safeResolveReal(root, target);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * 打开备份目录（backup:openFolder）：目录回退解析 + 包含性校验 + 文件高亮 / 目录打开。
 *
 * 导出 openBackupFolder 而非只导出判定函数：真正的修复点是「调用前先校验」这一环，
 * 只测判定函数无法证明校验确实接在开目录路径上（曾出现删除守卫后测试仍全绿）。
 */
export async function openBackupFolder(
  projectPath: string,
  folderPath: string,
): Promise<boolean> {
  if (!folderPath || typeof folderPath !== 'string') return false;
  const target = await resolveOpenTarget(folderPath);
  if (target === null) return false;
  if (!isInsideBackupRoots(target, await resolveBackupRoots(projectPath))) {
    console.warn('[backup] 拒绝打开备份根之外的路径:', target);
    return false;
  }
  return revealOrOpenTarget(target);
}

function registerOpenFolderHandler(): void {
  ipcMain.handle(
    'backup:openFolder',
    async (_event, projectPath: string, folderPath: string): Promise<boolean> => {
      return openBackupFolder(projectPath, folderPath);
    },
  );
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

/** syncProjectSchedule 的依赖注入集合：调度器、配置读取与备份执行 */
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

// ─── 备份健康快照（十域评分章程 #10，报告中心汇总只读消费）──────

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
    const own = records.filter((r) => r.projectId === projectPath);
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

/** 定时备份：启动时按各项目 backup.yml 注册任务 */
function setupScheduledBackups(
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
  registerRecordsHandler(orchestrator);
  registerRecordHandler(orchestrator);
  registerDeleteRecordHandler(orchestrator);
  registerConfigHandlers(configManager, (projectPath) =>
    syncProjectSchedule(scheduleDeps, projectPath),
  );
  registerAuthorizeHandler();
  registerOpenFolderHandler();
}
