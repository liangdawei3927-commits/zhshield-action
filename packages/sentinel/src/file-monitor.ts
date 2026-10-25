import * as fs from 'fs';
import * as path from 'path';
import { sanitizeLogField, safeJoin } from '@zh/shared';
import { EventCenter } from './event-center';
import { FileEventReporter } from './file-events';
import type { FileChangeType } from './file-events';
import { GitIndexCache } from './git-index';

/**
 * 文件变更类型（上报口径见 file-events.ts）。
 * 本文件只负责「发现变化」，「怎么报」由 FileEventReporter 决定。
 */
export type { FileChangeType };
/** 文件监听过滤器：返回 true 表示该路径需要被监控 */
export type FileWatchFilter = (filePath: string) => boolean;

export const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'build-output',
  'coverage',
  'test-results',
  '.playwright-mcp',
  '.opencode',
  '.omo',
  '.zhshield',
  '.turbo',
];

/**
 * 默认噪音路径正则。
 *
 * 其中 `.app/.framework/.xpc/.appex` 一段专治 macOS 应用包：`.app` 及其内嵌框架
 * 是纯二进制产物，逐文件监控毫无信号，且 electron-builder 重建时会先删旧包再写
 * 新包 —— 2026-10-25 实测一个 338 文件的 `智汇码盾.app` 重建直接炸出 270 条 p2
 * 事件，220 条标题都叫「File unlink: locale.pak」。
 * 按后缀匹配而非按包名逐个加白名单：包名叫产品名，列举永远追不上。
 */
export const DEFAULT_IGNORE_RE = new RegExp(
  '(?:^|[\\\\/])(?:node_modules|dist-electron|coverage|test-results|\\.playwright-mcp|\\.playwright-artifacts-\\d+|\\.omo|\\.opencode|\\.zhshield)(?:[\\\\/]|$)' +
    '|(?:^|[\\\\/])[^\\\\/]+\\.(?:app|framework|xpc|appex)(?:[\\\\/]|$)' +
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

/**
 * 噪音路径判定：命中被监控根之下的任意忽略目录段，或命中默认噪音正则。
 * fs.watch 回调需与轮询遍历保持一致（此前仅轮询跳过 ignoreDirs）。
 * 只检查 watchPath 之后的相对段，用户显式监控噪音目录本身时内容不误杀。
 *
 * 导出原因：历史事件收敛（`out-of-scope-prune.ts`）要拿**同一套规则**判断
 * 旧事件路径是否已越界。否则收敛口径与监控口径各写一份，迟早不同步。
 */
export function isIgnoredPath(
  fullPath: string,
  watchPath: string,
  ignoreDirs?: readonly string[],
): boolean {
  const rel = path.relative(watchPath, fullPath);
  if (rel) {
    const ignoreSet = new Set(ignoreDirs ?? DEFAULT_IGNORE_DIRS);
    for (const segment of rel.split(path.sep)) {
      if (ignoreSet.has(segment)) return true;
    }
  }
  return DEFAULT_IGNORE_RE.test(fullPath);
}

function isNoisePath(fullPath: string, watchPath: string, config: FileMonitorConfig): boolean {
  return isIgnoredPath(fullPath, watchPath, config.ignoreDirs);
}

/** 目录是否存在（只看目录，文件/不存在都算不存在） */
async function dirExists(target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 找出整树删除的根：从被删文件向上走，取**最高**的那个已不存在的祖先。
 *
 * 为什么需要：macOS 递归 fs.watch 对 `rm -rf` 是**逐文件**上报的，一个
 * 338 文件的应用包重建会直接炸出几百条 p2 事件，标题还都退化成 basename
 * （220 个 `locale.pak` 长得一模一样）。折叠后才能还原「这是一个目录被删了」。
 *
 * 返回 null 表示只有该文件本身被删、父目录还在 —— 按单文件删除处理，不许折叠。
 * `stopAt` 是监控根，防止一路走到根目录把整个项目误判成被删。
 */
export async function findRemovedRoot(fullPath: string, stopAt: string): Promise<string | null> {
  const floor = path.resolve(stopAt);
  let removed: string | null = null;
  let dir = path.dirname(path.resolve(fullPath));
  while (dir.length > floor.length && dir.startsWith(floor)) {
    if (await dirExists(dir)) break;
    removed = dir;
    dir = path.dirname(dir);
  }
  return removed;
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

/** 文件监控器配置：归属项目、监听路径、轮询间隔、路径过滤与忽略目录 */
export interface FileMonitorConfig {
  projectId: string;
  watchPaths: string[];
  intervalMs?: number;
  filter?: FileWatchFilter;
  /** 整目录跳过的名称（如 node_modules/.git/dist/.turbo），fs.watch 与轮询一致跳过 */
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
  /** 上报职责在 FileEventReporter —— 本类只管发现变化，不碰事件口径 */
  private readonly reporter: FileEventReporter;
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private pollTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastMtimes: Map<string, number> = new Map();
  private lastEventAt: Map<string, number> = new Map();
  private pollInFlight: Set<string> = new Set();
  private running: boolean = false;
  /** 交付物索引缓存：unlink 时判断该路径是否属于 git 跟踪的文件（见 git-index.ts） */
  private readonly gitIndex = new GitIndexCache();

  constructor(eventCenter: EventCenter) {
    this.reporter = new FileEventReporter(eventCenter);
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
    this.gitIndex.clear();
  }

  private watchPath(watchPath: string, config: FileMonitorConfig): void {
    try {
      const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
        if (!this.running || !filename) return;
        this.lastEventAt.set(watchPath, Date.now());
        const fullPath = safeJoin(watchPath, filename);
        if (config.filter && !config.filter(fullPath)) return;
        if (isNoisePath(fullPath, watchPath, config)) return;
        void this.handleChange(config.projectId, fullPath, watchPath, eventType as FileChangeType);
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
    if (isNoisePath(fullPath, watchPath, config)) return;
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
      this.reporter.emitMtimeChange({ fullPath, watchPath, projectId: config.projectId, mtime });
    }
    this.lastMtimes.set(fullPath, mtime);
  }

  private isModifiedSinceLast(fullPath: string, mtime: number): boolean {
    const last = this.lastMtimes.get(fullPath);
    return !!last && mtime > last;
  }

  private async handleChange(
    projectId: string,
    fullPath: string,
    watchPath: string,
    eventType: FileChangeType,
  ): Promise<void> {
    const stat = await this.statIfFile(fullPath);
    if (stat && !stat.isFile()) return;
    const wasKnown = this.lastMtimes.has(fullPath);
    const changeType = resolveChangeType(eventType, !!stat, wasKnown);
    // stat 为 null 时 resolveChangeType 必返回 unlink（见该函数），两件事收在一个分支里：
    // 既覆盖删除上报，又让后面的 stat 是收窄后的非空值 —— 不再用非空断言跳过空值检查。
    if (changeType === 'unlink' || stat === null) {
      await this.handleUnlink(projectId, fullPath, watchPath, wasKnown);
      return;
    }
    this.recordMtimeChange({
      projectId,
      fullPath,
      watchPath,
      mtime: stat.mtimeMs,
      changeType,
    });
  }

  /** 读取文件状态；不存在或读取失败返回 null */
  private async statIfFile(fullPath: string): Promise<fs.Stats | null> {
    try {
      return await fs.promises.stat(fullPath);
    } catch {
      return null;
    }
  }

  /**
   * 处理 unlink：仅当此前已知该文件时上报删除事件。
   *
   * 整树删除（如 rm -rf、electron-builder 重建应用包）会被折叠成一条：
   * macOS 递归 fs.watch 逐文件上报，不折叠的话一个应用包就是几百条 p2。
   *
   * 上报前还要判一次「消失的是不是交付物」（`git-index.ts`）：未跟踪的
   * 临时文件/探针脚本被删属正常生命周期，降级为 p3 信息类事件。索引不可判定
   * （非 git 仓库）时保持原 p2 强度 —— 宁可多报，不可吞掉真实的交付物删除。
   */
  private async handleUnlink(
    projectId: string,
    fullPath: string,
    watchPath: string,
    wasKnown: boolean,
  ): Promise<void> {
    if (!wasKnown) return;
    const removedRoot = await findRemovedRoot(fullPath, watchPath);
    const target = removedRoot ?? fullPath;
    // 交付物判定必须放在 purge/emit **之前**：purge 与 emit 之间一旦夹 await，
    // 整树删除的 collapsedCount 会被后续文件事件抢跑（首次事件记账成 0）。
    // 索引锚点由 git-index 自己解析（目标最近的仓库根），不能传监控根：
    // 监控根是外层文档仓库，内层代码仓库里的已跟踪文件会被误判成未跟踪。
    const tracked = await this.gitIndex.isTracked(target);
    if (removedRoot) {
      const collapsedCount = this.purgeKnownUnder(removedRoot);
      this.reporter.emitFileChangeEvent({
        projectId,
        fullPath: removedRoot,
        watchPath,
        changeType: 'unlink',
        collapsedCount,
        tracked,
      });
      return;
    }
    this.lastMtimes.delete(fullPath);
    this.reporter.emitFileChangeEvent({ projectId, fullPath, watchPath, changeType: 'unlink', tracked });
  }

  /**
   * 清掉整棵已删除子树下的已知 mtime 记录，返回被清掉的条数。
   * 必须先清再报：后续同树文件到达时 wasKnown 为假，直接短路，不再重复上报。
   */
  private purgeKnownUnder(root: string): number {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    let count = 0;
    for (const key of [...this.lastMtimes.keys()]) {
      if (key === root || key.startsWith(prefix)) {
        this.lastMtimes.delete(key);
        count += 1;
      }
    }
    return count;
  }

  /** 记录 mtime 变化；仅当 mtime 前进时上报变更事件 */
  private recordMtimeChange(input: {
    projectId: string;
    fullPath: string;
    watchPath: string;
    mtime: number;
    changeType: FileChangeType;
  }): void {
    const { projectId, fullPath, watchPath, mtime, changeType } = input;
    const prev = this.lastMtimes.get(fullPath);
    this.lastMtimes.set(fullPath, mtime);
    if (prev !== undefined && mtime <= prev) return;
    this.reporter.emitFileChangeEvent({ projectId, fullPath, watchPath, changeType });
  }
}
