/**
 * 哨兵监控 IPC（ipc/sentinel.ts）
 *
 * 事件查询 / 文件监控 + 日志采集启动（排除依赖目录避免噪音事件）。
 * 监控启动为幂等操作：同一项目重复调用不重复启动（避免多轮 ProcessMonitor 双跑）。
 */

import { ipcMain, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import type { SentinelEvent, EventStatus, EventSeverity } from '@zh/sentinel';
import { detectRunCommand, discoverLogPaths, defaultFileWatchFilter, DEFAULT_IGNORE_DIRS } from '@zh/sentinel';
import { getSentinel, stopAllMonitoring, type SentinelRuntime } from '../ipc-context';

const STATE_FILE = 'sentinel-state.json';

interface SentinelState {
  enabled: boolean;
}

const DEFAULT_STATE: SentinelState = { enabled: true };

function getStatePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function readStateSync(): SentinelState {
  try {
    const data = fs.readFileSync(getStatePath(), 'utf-8');
    const parsed = JSON.parse(data) as Partial<SentinelState>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_STATE.enabled,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function writeStateSync(state: SentinelState): void {
  try {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), 'utf-8');
  } catch { /* best-effort persistence */ }
}

// 已启动监控的项目（幂等保护：重复 startMonitoring 不重复启动进程/日志监听）
const monitoredProjects = new Set<string>();

function registerStateIpc(): void {
  ipcMain.handle('sentinel:getState', (): SentinelState => readStateSync());

  ipcMain.handle('sentinel:setEnabled', (_event, enabled: boolean): { ok: boolean } => {
    writeStateSync({ enabled });
    if (!enabled) {
      stopAllMonitoring();
      monitoredProjects.clear();
    }
    return { ok: true };
  });
}

/** 启动文件监控：项目目录存在时挂载哨兵，返回启动/跳过说明 */
function startFileMonitoring(fileMonitor: SentinelRuntime['fileMonitor'], projectId: string, projectPath: string): string[] {
  if (!fs.existsSync(projectPath)) {
    return [`file-monitor: path not found (${projectPath})`];
  }
  fileMonitor.start({
    projectId,
    watchPaths: [projectPath],
    intervalMs: 5000,
    ignoreDirs: DEFAULT_IGNORE_DIRS,
    filter: defaultFileWatchFilter,
  });
  return ['file-monitor'];
}

/** 启动日志采集：按 package.json 识别运行命令并采集 logs/ 与根目录日志，返回启动/跳过说明 */
function startLogCollecting(logCollector: SentinelRuntime['logCollector'], projectId: string, projectPath: string): string[] {
  const logPaths = discoverLogPaths(projectPath);
  if (logPaths.length === 0) {
    return ['log-collector: no log files found'];
  }
  logCollector.start({ projectId, logPaths, projectPath });
  return [`log-collector (${logPaths.length} files)`];
}

/** 启动进程监控：识别 dev/start/build 命令并启动，返回启动/跳过说明 */
function startProcessMonitoring(processMonitor: SentinelRuntime['processMonitor'], projectId: string, projectPath: string): string[] {
  const runCommand = detectRunCommand(projectPath);
  if (!runCommand) {
    return ['process-monitor: no dev/start/build script found'];
  }
  processMonitor.start({ projectId, command: runCommand.command, cwd: projectPath });
  return [`process-monitor (npm run ${runCommand.script})`];
}

/** 事件查询 IPC：列表 + 单条查询 */
function registerEventQuery(): void {
  ipcMain.handle('sentinel:getEvents', async (_event, options?: { status?: string; severity?: string }): Promise<SentinelEvent[]> => {
    const { eventCenter } = await getSentinel();
    return eventCenter.listEvents(options as { status?: EventStatus; severity?: EventSeverity } | undefined);
  });

  ipcMain.handle('sentinel:getEvent', async (_event, id: string): Promise<SentinelEvent | undefined> => {
    const { eventCenter } = await getSentinel();
    return eventCenter.getEvent(id);
  });
}

/** 监控启停 IPC：启动文件监控、日志采集与进程监控（幂等） */
function registerMonitoringStart(): void {
  ipcMain.handle(
    'sentinel:startMonitoring',
    async (_event, projectId: string, projectPath: string): Promise<{ ok: boolean; started: string[]; skipped: string[]; disabled?: boolean }> => {
      const state = readStateSync();
      if (!state.enabled) {
        return { ok: false, started: [], skipped: [], disabled: true };
      }

      const { fileMonitor, logCollector, processMonitor } = await getSentinel();
      const started: string[] = [];
      const skipped: string[] = [];

      if (monitoredProjects.has(projectId)) {
        return { ok: true, started: ['already-running'], skipped: [] };
      }

      for (const note of [
        ...startFileMonitoring(fileMonitor, projectId, projectPath),
        ...startLogCollecting(logCollector, projectId, projectPath),
        ...startProcessMonitoring(processMonitor, projectId, projectPath),
      ]) {
        if (note.includes('path not found') || note.includes('no log files') || note.includes('no dev/start/build')) {
          skipped.push(note);
        } else {
          started.push(note);
        }
      }

      if (started.length > 0) monitoredProjects.add(projectId);

      return { ok: started.length > 0, started, skipped };
    },
  );
}

export function registerSentinelIpc(): void {
  registerStateIpc();
  registerEventQuery();
  registerMonitoringStart();
}
