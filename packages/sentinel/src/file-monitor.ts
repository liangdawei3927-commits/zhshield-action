import * as fs from 'fs';
import * as path from 'path';
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

export function resolveChangeType(eventType: string, existsOnDisk: boolean, wasKnown: boolean): FileChangeType {
  if (eventType === 'unlink') return 'unlink';
  if (!existsOnDisk) return 'unlink';
  if (eventType === 'rename') return wasKnown ? 'change' : 'add';
  return 'change';
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
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private lastMtimes = new Map<string, number>();
  private running = false;

  constructor(eventCenter: EventCenter) {
    this.eventCenter = eventCenter;
  }

  start(config: FileMonitorConfig): void {
    this.running = true;
    const interval = config.intervalMs || 3000;

    for (const watchPath of config.watchPaths) {
      if (!fs.existsSync(watchPath)) {
        console.warn(`[FileMonitor] Path does not exist, skipping: ${watchPath}`);
        continue;
      }
      this.watchPath(watchPath, config);
      const timer = setInterval(() => this.pollPath(watchPath, config), interval);
      this.pollTimers.set(watchPath, timer);
    }
  }

  stop(): void {
    this.running = false;
    for (const [watchPath, timer] of this.pollTimers) {
      clearInterval(timer);
      this.pollTimers.delete(watchPath);
    }
    for (const [watchPath, watcher] of this.watchers) {
      watcher.close();
      this.watchers.delete(watchPath);
    }
    this.lastMtimes.clear();
  }

  private watchPath(watchPath: string, config: FileMonitorConfig): void {
    try {
      const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
        if (!this.running || !filename) return;
        const fullPath = path.join(watchPath, filename);
        if (config.filter && !config.filter(fullPath)) return;
        this.handleChange(config.projectId, fullPath, eventType as FileChangeType);
      });
      this.watchers.set(watchPath, watcher);
    } catch (err) {
      console.error(`[FileMonitor] Failed to watch ${watchPath}:`, err);
    }
  }

  private pollPath(watchPath: string, config: FileMonitorConfig): void {
    if (!this.running) return;
    try {
      const state: ScanState = {
        ignoreSet: new Set(config.ignoreDirs ?? []),
        watchPath,
        config,
        stack: [watchPath],
      };
      while (state.stack.length > 0) {
        this.scanDirEntries(state.stack.pop()!, state);
      }
    } catch {
      // Directory may have been removed during iteration
    }
  }

  private scanDirEntries(dir: string, state: ScanState): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Directory may have been removed during iteration
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !state.ignoreSet.has(entry.name)) {
        state.stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      this.inspectFileEntry(path.join(dir, entry.name), state.watchPath, state.config);
    }
  }

  private inspectFileEntry(fullPath: string, watchPath: string, config: FileMonitorConfig): void {
    if (config.filter && !config.filter(fullPath)) return;
    this.checkMtime(fullPath, watchPath, config);
  }

  private checkMtime(fullPath: string, watchPath: string, config: FileMonitorConfig): void {
    const stat = fs.statSync(fullPath);
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

  private emitMtimeChange(fullPath: string, watchPath: string, projectId: string, mtime: number): void {
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

  private handleChange(projectId: string, fullPath: string, eventType: FileChangeType): void {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      stat = null;
    }
    if (stat && !stat.isFile()) return;

    const wasKnown = this.lastMtimes.has(fullPath);
    const changeType = resolveChangeType(eventType, !!stat, wasKnown);

    if (changeType === 'unlink') {
      if (!wasKnown) return;
      this.lastMtimes.delete(fullPath);
      this.emitFileChangeEvent(projectId, fullPath, 'unlink');
      return;
    }

    const mtime = stat!.mtimeMs;
    const prev = this.lastMtimes.get(fullPath);
    this.lastMtimes.set(fullPath, mtime);
    if (prev !== undefined && mtime <= prev) return;
    this.emitFileChangeEvent(projectId, fullPath, changeType);
  }

  private emitFileChangeEvent(projectId: string, fullPath: string, changeType: FileChangeType): void {
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
