import * as fs from 'fs';
import * as path from 'path';
import { sanitizeLogField, safeJoin } from '@zh/shared';
import { EventCenter } from './event-center';

export type FileChangeType = 'add' | 'change' | 'unlink';
export type FileWatchFilter = (filePath: string) => boolean;

export const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'coverage',
  'test-results',
  '.playwright-mcp',
  '.opencode',
  '.omo',
  '.zhshield',
  '.turbo',
];

export const DEFAULT_IGNORE_RE = new RegExp(
  '(?:^|[\\\\/])(?:node_modules|dist-electron|coverage|test-results|\\.playwright-mcp|\\.playwright-artifacts-\\d+|\\.omo|\\.opencode|\\.zhshield)(?:[\\\\/]|$)' +
    '|(?:^|[\\\\/])_tmp_\\d+_' +
    '|\\.tsbuildinfo$' +
    '|(?:^|[\\\\/])\\.!\\d+!' +
    '|(?:^|[\\\\/])\\.#' +
    '|\\.sw[po]?$' +
    '|(?:^|[\\\\/])\\.DS_Store$',
);

export function defaultFileWatchFilter(filePath: string): boolean {
  return !DEFAULT_IGNORE_RE.test(filePath);
}

export function resolveChangeType(
  eventType: string,
  existsOnDisk: boolean,
  wasKnown: boolean,
): FileChangeType {
  if (eventType === 'unlink') return 'unlink';
  if (!existsOnDisk) return 'unlink';
  if (eventType === 'rename') return wasKnown ? 'change' : 'add';
  return 'change';
}

/** 事件活跃时轮询退避的上限（毫秒） */
export const MAX_POLL_BACKOFF_MS = 30_000;

/**
 * 计算下一次轮询的延迟：
 * - 心跳在 intervalMs 内（事件活跃）→ 退避到 min(MAX_POLL_BACKOFF_MS, intervalMs * 10)
 * - 安静（超过 intervalMs 无事件）→ 回到正常 intervalMs
 */
export function computePollDelay(
  lastEventAt: number,
  now: number,
  intervalMs: number,
  maxBackoffMs: number = MAX_POLL_BACKOFF_MS,
): number {
  const sinceEvent = now - lastEventAt;
  if (sinceEvent < intervalMs) {
    return Math.min(maxBackoffMs, intervalMs * 10);
  }
  return intervalMs;
}

export interface FileMonitorConfig {
  projectId: string;
  watchPaths: string[];
  intervalMs?: number;
  filter?: FileWatchFilter;
  /** 遍历时整目录跳过的名称（如 node_modules/.git），避免同步扫描依赖树阻塞进程 */
  ignoreDirs?: string[];
}

/** 一次 pollPath 目录遍历期间共享的扫描上下文 */
interface ScanState {
  ignoreSet: Set<string>;
  watchPath: string;
  config: FileMonitorConfig;
  stack: string[];
}

export class FileMonitor {
  private eventCenter: EventCenter;
  private watchers = new Map<string, fs.FSWatcher>();
  private pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastMtimes = new Map<string, number>();
  private lastEventAt = new Map<string, number>();
  private pollInFlight = new Set<string>();
  private running = false;

  constructor(eventCenter: EventCenter) {
    this.eventCenter = eventCenter;
  }

  start(config: FileMonitorConfig): void {
    this.running = true;
    const effectiveConfig: FileMonitorConfig = {
      ...config,
      ignoreDirs: config.ignoreDirs ?? DEFAULT_IGNORE_DIRS,
    };

    for (const watchPath of effectiveConfig.watchPaths) {
      if (!fs.existsSync(watchPath)) {
        console.warn(`[FileMonitor] Path does not exist, skipping: ${watchPath}`);
        continue;
      }
      this.watchPath(watchPath, effectiveConfig);
      this.scheduleNextPoll(watchPath, effectiveConfig);
    }
  }

  stop(): void {
    this.running = false;
    for (const [watchPath, timer] of this.pollTimers) {
      clearTimeout(timer);
      this.pollTimers.delete(watchPath);
    }
    for (const [watchPath, watcher] of this.watchers) {
      watcher.close();
      this.watchers.delete(watchPath);
    }
    this.lastMtimes.clear();
    this.lastEventAt.clear();
    this.pollInFlight.clear();
  }

  private watchPath(watchPath: string, config: FileMonitorConfig): void {
    try {
      const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
        if (!this.running || !filename) return;
        this.lastEventAt.set(watchPath, Date.now());
        const fullPath = safeJoin(watchPath, filename);
        if (config.filter && !config.filter(fullPath)) return;
        void this.handleChange(config.projectId, fullPath, eventType as FileChangeType);
      });
      this.watchers.set(watchPath, watcher);
    } catch (err) {
      console.error('[FileMonitor] Failed to watch %s:', sanitizeLogField(watchPath), err);
    }
  }

  private scheduleNextPoll(watchPath: string, config: FileMonitorConfig): void {
    const interval = config.intervalMs || 3000;
    const lastEvent = this.lastEventAt.get(watchPath) ?? 0;
    const delay = computePollDelay(lastEvent, Date.now(), interval);
    const timer = setTimeout(() => {
      this.pollTimers.delete(watchPath);
      void this.pollPath(watchPath, config).finally(() => {
        if (this.running) this.scheduleNextPoll(watchPath, config);
      });
    }, delay);
    this.pollTimers.set(watchPath, timer);
  }

  private async pollPath(watchPath: string, config: FileMonitorConfig): Promise<void> {
    if (!this.running) return;
    if (this.pollInFlight.has(watchPath)) return;
    this.pollInFlight.add(watchPath);
    try {
      const state: ScanState = {
        ignoreSet: new Set(config.ignoreDirs ?? []),
        watchPath,
        config,
        stack: [watchPath],
      };
      while (state.stack.length > 0) {
        await this.scanDirEntries(state.stack.pop()!, state);
      }
    } catch {
      // Directory may have been removed during iteration
    } finally {
      this.pollInFlight.delete(watchPath);
    }
  }

  private async scanDirEntries(dir: string, state: ScanState): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Directory may have been removed during iteration
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !state.ignoreSet.has(entry.name)) {
        state.stack.push(safeJoin(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      await this.inspectFileEntry(safeJoin(dir, entry.name), state.watchPath, state.config);
    }
  }

  private async inspectFileEntry(
    fullPath: string,
    watchPath: string,
    config: FileMonitorConfig,
  ): Promise<void> {
    if (config.filter && !config.filter(fullPath)) return;
    await this.checkMtime(fullPath, watchPath, config);
  }

  private async checkMtime(
    fullPath: string,
    watchPath: string,
    config: FileMonitorConfig,
  ): Promise<void> {
    const stat = await fs.promises.stat(fullPath);
    const mtime = stat.mtimeMs;
    if (this.isModifiedSinceLast(fullPath, mtime)) {
      this.emitMtimeChange(fullPath, watchPath, config.projectId, mtime);
    }
    this.lastMtimes.set(fullPath, mtime);
  }

  private isModifiedSinceLast(fullPath: string, mtime: number): boolean {
    const last = this.lastMtimes.get(fullPath);
    return !!last && mtime > last;
  }

  private emitMtimeChange(
    fullPath: string,
    watchPath: string,
    projectId: string,
    mtime: number,
  ): void {
    this.eventCenter.createEvent({
      projectId,
      title: `File changed: ${path.relative(watchPath, fullPath)}`,
      service: 'sentinel',
      module: 'file-monitor',
      severity: 'p3',
      context: { filePath: fullPath, changeType: 'change', mtime: new Date(mtime).toISOString() },
      operator: 'file-monitor',
      action: 'file-changed',
      detail: `File modified: ${fullPath}`,
    });
  }

  private async handleChange(
    projectId: string,
    fullPath: string,
    eventType: FileChangeType,
  ): Promise<void> {
    const stat = await this.statIfFile(fullPath);
    if (stat && !stat.isFile()) return;
    const wasKnown = this.lastMtimes.has(fullPath);
    const changeType = resolveChangeType(eventType, !!stat, wasKnown);
    if (changeType === 'unlink') {
      this.handleUnlink(projectId, fullPath, wasKnown);
      return;
    }
    this.recordMtimeChange(projectId, fullPath, stat!, changeType);
  }

  /** 读取文件状态；不存在或读取失败返回 null */
  private async statIfFile(fullPath: string): Promise<fs.Stats | null> {
    try {
      return await fs.promises.stat(fullPath);
    } catch {
      return null;
    }
  }

  /** 处理 unlink：仅当此前已知该文件时上报删除事件 */
  private handleUnlink(projectId: string, fullPath: string, wasKnown: boolean): void {
    if (!wasKnown) return;
    this.lastMtimes.delete(fullPath);
    this.emitFileChangeEvent(projectId, fullPath, 'unlink');
  }

  /** 记录 mtime 变化；仅当 mtime 前进时上报变更事件 */
  private recordMtimeChange(
    projectId: string,
    fullPath: string,
    stat: fs.Stats,
    changeType: FileChangeType,
  ): void {
    const mtime = stat.mtimeMs;
    const prev = this.lastMtimes.get(fullPath);
    this.lastMtimes.set(fullPath, mtime);
    if (prev !== undefined && mtime <= prev) return;
    this.emitFileChangeEvent(projectId, fullPath, changeType);
  }

  private emitFileChangeEvent(
    projectId: string,
    fullPath: string,
    changeType: FileChangeType,
  ): void {
    this.eventCenter.createEvent({
      projectId,
      title: `File ${changeType}: ${path.basename(fullPath)}`,
      service: 'sentinel',
      module: 'file-monitor',
      severity: changeType === 'unlink' ? 'p2' : 'p3',
      context: { filePath: fullPath, changeType },
      operator: 'file-monitor',
      action: `file-${changeType}`,
      detail: `File ${changeType}: ${fullPath}`,
    });
  }
}
