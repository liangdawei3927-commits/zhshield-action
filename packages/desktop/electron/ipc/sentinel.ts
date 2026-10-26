/**
 * 哨兵监控 IPC（ipc/sentinel.ts）
 *
 * 事件查询 / 文件监控 + 日志采集启动（排除依赖目录避免噪音事件）。
 * 监控启动为幂等操作：同一项目重复调用不重复启动（避免多轮 ProcessMonitor 双跑）。
 */

import { ipcMain, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

import type { SentinelEvent, EventFilters } from '@zh/sentinel';
import {
  detectRunCommand,
  discoverLogPaths,
  defaultFileWatchFilter,
  DEFAULT_IGNORE_DIRS,
  isInformationalEvent,
  pruneStaleFileEvents,
} from '@zh/sentinel';
import type { SentinelEventQuery } from '../../src/types/electron';
import { getSentinel, stopAllMonitoring, getDb, type SentinelRuntime } from '../ipc-context';
import { readSentinelHealthFromDb } from '../sentinel-health';
import { applyMonitoringStop } from '../sentinel-monitoring';

const STATE_FILE = 'sentinel-state.json';

interface SentinelState {
  enabled: boolean;
}

const DEFAULT_STATE: SentinelState = { enabled: true };

function getStatePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

async function readState(): Promise<SentinelState> {
  try {
    const data = await fs.readFile(getStatePath(), 'utf-8');
    const parsed = JSON.parse(data) as Partial<SentinelState>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_STATE.enabled,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

async function writeState(state: SentinelState): Promise<void> {
  try {
    const dir = app.getPath('userData');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(getStatePath(), JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[sentinel] 状态持久化失败:', err instanceof Error ? err.message : String(err));
  }
}

// 已启动监控的项目（幂等保护：重复 startMonitoring 不重复启动进程/日志监听）
// 值保留项目路径：暂停某项目后，其余项目的监视器要按它重新挂回（见 stopMonitoringForProject）
const monitoredProjects = new Map<string, string>();
/** 已做过历史事件收敛的项目（每进程每项目一次，避免每次刷新都扫库） */
const prunedProjects = new Set<string>();

/**
 * 历史越界事件收敛：忽略规则收紧后，库里那批旧事件描述的路径本就不该被监控。
 *
 * 为什么必须有这一步：只修生成端时，库里 270 条旧 unlink 事件仍是
 * `deleted_at IS NULL`，页面与「复制到AI」会一直显示它们 —— 用户看到的是
 * 「代码明明修好了，为什么还是 270 个问题」。收敛是维护动作，失败只告警，
 * 绝不阻断监控启动。
 */
function pruneOutOfScopeEventsOnce(projectId: string): void {
  if (prunedProjects.has(projectId)) return;
  prunedProjects.add(projectId);
  // 收敛函数要读一次项目 git 索引（判据 C），因此是异步的；这里不 await 结果，
  // 只保证不阻塞监控启动 —— 失败同样只告警。无持久化模式下 getDb 抛错，等同跳过。
  void (async (): Promise<number> => {
    const removed = await pruneStaleFileEvents(getDb(), projectId);
    if (removed > 0) {
      console.info(
        `[sentinel] 已收敛 ${removed} 条失效历史事件（路径越界 / 删除未落地 / 未跟踪临时文件）`,
      );
    }
    return removed;
  })().catch((err: unknown) => {
    console.warn(
      '[sentinel] 历史事件收敛失败（不影响监控）:',
      err instanceof Error ? err.message : String(err),
    );
  });
}

function registerStateIpc(): void {
  ipcMain.handle('sentinel:getState', async (): Promise<SentinelState> => readState());

  ipcMain.handle(
    'sentinel:setEnabled',
    async (_event, enabled: boolean): Promise<{ ok: boolean }> => {
      await writeState({ enabled });
      if (!enabled) {
        stopAllMonitoring();
        monitoredProjects.clear();
      }
      return { ok: true };
    },
  );
}

/** 启动文件监控：项目目录存在时挂载哨兵，返回启动/跳过说明 */
async function startFileMonitoring(
  fileMonitor: SentinelRuntime['fileMonitor'],
  projectId: string,
  projectPath: string,
): Promise<string[]> {
  try {
    await fs.access(projectPath);
  } catch {
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
function startLogCollecting(
  logCollector: SentinelRuntime['logCollector'],
  projectId: string,
  projectPath: string,
): string[] {
  const logPaths = discoverLogPaths(projectPath);
  if (logPaths.length === 0) {
    return ['log-collector: no log files found'];
  }
  logCollector.start({ projectId, logPaths, projectPath });
  return [`log-collector (${logPaths.length} files)`];
}

/** 启动进程监控：识别 dev/start/build 命令并启动，返回启动/跳过说明 */
function startProcessMonitoring(
  processMonitor: SentinelRuntime['processMonitor'],
  projectId: string,
  projectPath: string,
): string[] {
  const runCommand = detectRunCommand(projectPath);
  if (!runCommand) {
    return ['process-monitor: no dev/start/build script found'];
  }
  processMonitor.start({ projectId, command: runCommand.command, cwd: projectPath });
  return [`process-monitor (npm run ${runCommand.script})`];
}

/** 按跳过标记把启动说明归入 started / skipped 桶 */
function classifyStartupNotes(notes: string[], started: string[], skipped: string[]): void {
  for (const note of notes) {
    if (
      note.includes('path not found') ||
      note.includes('no log files') ||
      note.includes('no dev/start/build')
    ) {
      skipped.push(note);
    } else {
      started.push(note);
    }
  }
}

/** 依次启动文件监控、日志采集与进程监控，返回启动/跳过说明 */
async function startMonitors(
  runtime: SentinelRuntime,
  projectId: string,
  projectPath: string,
): Promise<{ started: string[]; skipped: string[] }> {
  const started: string[] = [];
  const skipped: string[] = [];
  classifyStartupNotes(
    [
      ...(await startFileMonitoring(runtime.fileMonitor, projectId, projectPath)),
      ...startLogCollecting(runtime.logCollector, projectId, projectPath),
      ...startProcessMonitoring(runtime.processMonitor, projectId, projectPath),
    ],
    started,
    skipped,
  );
  return { started, skipped };
}

/** 事件查询 IPC：列表 + 单条查询 */
function registerEventQuery(): void {
  ipcMain.handle(
    'sentinel:getEvents',
    async (_event, options?: SentinelEventQuery): Promise<SentinelEvent[]> => {
      const { eventCenter } = await getSentinel();
      // projectId 必须透传：事件表是多项目共用的，缺省会跨项目串显
      //（2026-10-26 实测：外层项目页面显示了内层项目的 3 条 p2 待处理事件）
      const events = eventCenter.listEvents(options as EventFilters | undefined);
      if (options?.excludeInformational !== true) return events;
      return events.filter((event) => !isInformationalEvent(event));
    },
  );

  ipcMain.handle(
    'sentinel:getEvent',
    async (_event, id: string): Promise<SentinelEvent | undefined> => {
      const { eventCenter } = await getSentinel();
      return eventCenter.getEvent(id);
    },
  );
}

/** 启动文件监控、日志采集与进程监控（幂等），返回启动/跳过说明 */
async function startMonitoringForProject(
  projectId: string,
  projectPath: string,
): Promise<{ ok: boolean; started: string[]; skipped: string[]; disabled?: boolean }> {
  const state = await readState();
  if (!state.enabled) {
    return { ok: false, started: [], skipped: [], disabled: true };
  }

  const runtime = await getSentinel();
  pruneOutOfScopeEventsOnce(projectId);
  if (monitoredProjects.has(projectId)) {
    return { ok: true, started: ['already-running'], skipped: [] };
  }

  const { started, skipped } = await startMonitors(runtime, projectId, projectPath);
  if (started.length > 0) monitoredProjects.set(projectId, projectPath);

  return { ok: started.length > 0, started, skipped };
}

/** 监控启停 IPC：启动文件监控、日志采集与进程监控（幂等） */
function registerMonitoringStart(): void {
  ipcMain.handle(
    'sentinel:startMonitoring',
    async (
      _event,
      projectId: string,
      projectPath: string,
    ): Promise<{ ok: boolean; started: string[]; skipped: string[]; disabled?: boolean }> => {
      return startMonitoringForProject(projectId, projectPath);
    },
  );
}

/**
 * 停止指定项目的监控。
 *
 * 必须真的停，而不是只在前端改状态 —— 用户诉求就是「点下去停不了」。
 * 三个监视器是进程内单例（stop() 无参数、只能整体停），所以：
 *   - 该项目是最后一个 ⇒ 直接整体停；
 *   - 还有别的项目在监控 ⇒ 整体停后按监控表重新挂回其余项目。
 * 后者的代价是其余项目的文件监听会重建（进程监控随重启重建子进程），这是单例
 * 模型的固有限制，比"点停止什么都没发生"诚实。
 */
async function stopMonitoringForProject(
  projectId: string,
): Promise<{ ok: boolean; stopped: boolean; restarted: string[] }> {
  const { stopped, remaining } = applyMonitoringStop(monitoredProjects, projectId);
  if (!stopped) {
    return { ok: true, stopped: false, restarted: [] };
  }
  if (remaining.length === 0) {
    stopAllMonitoring();
    return { ok: true, stopped: true, restarted: [] };
  }
  stopAllMonitoring();
  const runtime = await getSentinel();
  const restarted: string[] = [];
  for (const [id, path] of remaining) {
    const { started } = await startMonitors(runtime, id, path);
    if (started.length > 0) {
      restarted.push(id);
    } else {
      // 重启失败的项目不许再留在监控表里：否则页面仍显示"监控中"，而实际没在跑
      monitoredProjects.delete(id);
    }
  }
  return { ok: true, stopped: true, restarted };
}

/** 停止监控 IPC：真的停掉监视器（用户诉求：点下去要能停） */
function registerMonitoringStop(): void {
  ipcMain.handle(
    'sentinel:stopMonitoring',
    async (_event, projectId: string): Promise<{ ok: boolean; stopped: boolean; restarted: string[] }> => {
      return stopMonitoringForProject(projectId);
    },
  );
}

export function registerSentinelIpc(): void {
  registerStateIpc();
  registerEventQuery();
  registerMonitoringStart();
  registerMonitoringStop();
}

// ─── 哨兵健康数据（十域评分章程 #9，报告中心汇总只读消费）──────

/** 未终态的事件状态：仍在处理链路上的告警才计入扣分（passed/merged/deployed 已解决）。
 *  仅 DB 不可用时的内存回退分支使用；主路径由 `sentinel-health.ts` 持有同一份常量。 */
const TERMINAL = new Set(['passed', 'merged', 'deployed']);

/**
 * 只读指定项目的哨兵健康数据，供 buildPipelineExtras 组装 @zh/scoring 的 SentinelDataLike。
 * 返回 null = 该项目当前未在监控且从未产生事件 → 评分侧按 not-run 处理。
 * severity 映射：p1 → critical，p2 → warning，p3 不计入。
 *
 * **取数以 DB 为准**（2026-10-24 修复）：原先读 `eventCenter.listEvents()`（内存 Map），
 * 库里落盘的事件一条也读不到 ⇒ 哨兵域恒 100 分。实现见 `electron/sentinel-health.ts`。
 * DB 不可用（降级无持久化模式）时才退回内存，并在日志里说明计数可能偏低。
 */
export async function getSentinelHealthData(
  projectId: string,
): Promise<{ active: boolean; criticalEvents: number; warningEvents: number } | null> {
  const monitoring = monitoredProjects.has(projectId);
  const db = getDb();
  if (db) {
    try {
      const health = readSentinelHealthFromDb(db, projectId, { monitoring });
      return health
        ? {
            active: health.active,
            criticalEvents: health.criticalEvents,
            warningEvents: health.warningEvents,
          }
        : null;
    } catch (err) {
      console.warn(
        '[sentinel] DB 健康数据读取失败（退回内存态，计数可能偏低）:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  try {
    const runtime = await getSentinel();
    const events = runtime.eventCenter.listEvents();
    const own = events.filter((e) => e.projectId === projectId && !TERMINAL.has(e.status));
    if (!monitoring && own.length === 0) return null;
    return {
      active: monitoring,
      criticalEvents: own.filter((e) => e.severity === 'p1').length,
      warningEvents: own.filter((e) => e.severity === 'p2').length,
    };
  } catch (err) {
    console.warn(
      '[sentinel] 健康数据读取失败（按 not-run 处理）:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
