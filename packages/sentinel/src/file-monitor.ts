import * as fs from 'fs';
import * as path from 'path';
import { EventCenter } from './event-center';

export type FileChangeType = 'add' | 'change' | 'unlink';
export type FileWatchFilter = (filePath: string) => boolean;

/**
 * 默认排除的目录名（poll 遍历时按目录名整段跳过）。
 * 覆盖依赖树、构建产物、测试产物（Playwright）与工具状态（opencode/omo/zhshield），
 * 避免 `ses_*.json`、`test-results/`、`trace.zip` 等产生海量噪音事件。
 */
export const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  '.next',
  'build',
  'coverage',
  '.cache',
  '.turbo',
  'release',
  'test-results',
  '.playwright-artifacts',
  '.playwright-mcp',
  '.opencode',
  '.omo',
  '.zhshield',
];

/**
 * 文件级忽略：目录产物之外，还要排除临时文件、TypeScript 构建缓存
 * 与编辑器锁/临时文件（Vim 交换 `.!name`、Emacs 锁 `.#name`、Vim swap `*.swp`、
 * macOS Finder 元数据 `.DS_Store`），避免原子保存/打开编辑时产生噪音事件。
 */
export const DEFAULT_IGNORE_RE =
  /(^|\/)(node_modules|\.git|dist|dist-electron|\.next|build|coverage|release|test-results|\.playwright-artifacts-\d*|\.playwright-mcp|\.opencode|\.omo|\.zhshield|\.cache|\.turbo)(\/|$)|(^|\/)_tmp_[^/]*$|\.tsbuildinfo$|(^|\/)\.![^/]*$|(^|\/)\.#[^/]*$|\.DS_Store$|\.swp$|\.swo$|\.swx$/;

/** 默认文件级过滤：路径命中排除规则则跳过监控 */
export function defaultFileWatchFilter(filePath: string): boolean {
  return !DEFAULT_IGNORE_RE.test(filePath);
}

/**
 * 归一化 fs.watch 事件类型：macOS 上 fs.watch 对任何变更都发 `rename`，
 * 需结合磁盘状态解析为语义化类型，避免产生伪造的 "File rename" 事件。
 */
export function resolveChangeType(changeType: string, exists: boolean, wasKnown: boolean): FileChangeType {
  if (changeType === 'unlink' || !exists) return 'unlink';
  if (changeType === 'rename') return wasKnown ? 'change' : 'add';
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
        if (this.isIgnored(fullPath, config)) return;
        this.handleChange(config.projectId, fullPath, eventType as FileChangeType);
      });
      this.watchers.set(watchPath, watcher);
    } catch (err) {
      console.error(`[FileMonitor] Failed to watch ${watchPath}:`, err);
    }
  }

  /** 命中 filter 排除规则或位于 ignoreDirs 目录下时返回 true（watch 回调与 poll 共用） */
  private isIgnored(fullPath: string, config: FileMonitorConfig): boolean {
    if (config.filter && !config.filter(fullPath)) return true;
    if (!config.ignoreDirs || config.ignoreDirs.length === 0) return false;
    return fullPath.split(path.sep).some((seg) => config.ignoreDirs!.includes(seg));
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

  private handleChange(projectId: string, fullPath: string, changeType: FileChangeType): void {
    const stat = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
    // fs.watch 递归在 macOS 上会对目录自身触发 change 事件（子项增删/元数据变化时），
    // 目录不是文件监控目标，跳过避免产生 "File change: <目录名>" 噪声事件
    if (stat?.isDirectory()) return;
    const wasKnown = this.lastMtimes.has(fullPath);
    // 目录被删除/重命名时 stat 为 null 且此前从未被当作文件跟踪，
    // 跳过避免为目录删除产生 "File unlink: <目录名>" 噪声事件
    if (!stat && !wasKnown) return;
    const mtime = stat ? stat.mtimeMs : Date.now();
    // macOS 上编辑器原子保存（写临时文件后 rename 覆盖）会对同一写入触发多次 fs.watch 回调，
    // 文件 mtime 未变化时跳过，避免同一变更产生重复事件（如 "File change: runner.ts" ×6）
    if (stat && wasKnown && mtime <= (this.lastMtimes.get(fullPath) ?? 0)) return;
    this.lastMtimes.set(fullPath, mtime);
    if (!stat) {
      this.lastMtimes.delete(fullPath);
    }

    this.emitFileChangeEvent(projectId, fullPath, resolveChangeType(changeType, !!stat, wasKnown));
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
