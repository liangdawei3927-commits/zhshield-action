import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SopVersion } from '../_meta/sop-types';

/** 同步日志条目：时间戳 + 同步过程附加的任意键值字段（写入 sync.log 的单行记录） */
export interface SyncLogEntry {
  timestamp: string;
  [key: string]: unknown;
}

/**
 * 同步状态快照 — 跨进程持久化，作为健康度评估的唯一事实源。
 *
 * 存在的理由：健康度原先只看内存里的 lastSyncTime，进程重启即归零，
 * 于是「本次运行还没同步成功」被误判成「规则严重过期」。
 * 桌面端必然被反复启停，故同步状态必须落盘。
 */
export interface SopSyncState {
  /** 最近一次成功同步的 ISO 时间（含「已是最新」与紧急更新）；从未成功为 null */
  lastSuccessAt: string | null;
  /** 最近一次同步尝试的 ISO 时间，无论成败 */
  lastAttemptAt: string | null;
  /** 最近一次失败原因（SyncResult.reason 或异常消息）；最近一次成功则重置为 null */
  lastError: string | null;
  /** 是否曾经成功同步过：区分「从未接入云端」与「接入过但已过期」 */
  everSucceeded: boolean;
}

/** 空同步状态（从未尝试过同步） */
export function emptySyncState(): SopSyncState {
  return { lastSuccessAt: null, lastAttemptAt: null, lastError: null, everSucceeded: false };
}

/**
 * SopVersionStore — 本地版本号、同步状态与同步日志存储
 *
 * 负责 version.json / sync-state.json 的原子读写与 sync.log 追加。
 */
export class SopVersionStore {
  private readonly versionPath: string;
  private readonly logPath: string;
  private readonly statePath: string;

  constructor(cacheDir: string) {
    this.versionPath = path.join(cacheDir, 'version.json');
    this.logPath = path.join(cacheDir, 'sync.log');
    this.statePath = path.join(cacheDir, 'sync-state.json');
  }

  /**
   * 读取本地版本号（文件不存在视为无缓存）
   */
  async load(): Promise<SopVersion | null> {
    try {
      const raw = await fs.promises.readFile(this.versionPath, 'utf-8');
      return JSON.parse(raw) as SopVersion;
    } catch {
      return null;
    }
  }

  /** 原子写文件：先写 .tmp 再 rename，防止崩溃导致文件半写 */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, content, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  }

  /**
   * 保存版本号
   */
  async save(version: SopVersion): Promise<void> {
    await this.atomicWriteFile(this.versionPath, JSON.stringify(version, null, 2));
  }

  /**
   * 读取同步状态；文件缺失或损坏时回退到「从 version.json 回溯」。
   *
   * 回溯是升级兼容的关键：老用户的缓存目录里只有 version.json，
   * 若直接判定为「从未同步」，会把一份 30 天前的正常缓存误报成「尚未接入云端」——
   * 那只是把一种谎话换成另一种谎话。
   */
  async loadSyncState(): Promise<SopSyncState> {
    const parsed = await this.readSyncStateFile();
    if (parsed) return parsed;
    // sync.log 优先于 version.json：前者记的是本地真实同步时刻，
    // 后者是云端规则包的发布时间，二者可以相差一整天。
    const fromLog = await this.inferSyncStateFromLog();
    if (fromLog) return fromLog;
    return this.inferSyncStateFromVersion();
  }

  /** 保存同步状态（原子写，写失败不阻塞同步主流程） */
  async saveSyncState(state: SopSyncState): Promise<void> {
    try {
      await this.atomicWriteFile(this.statePath, JSON.stringify(state, null, 2));
    } catch {
      // 状态文件写失败不应让一次成功的同步变成失败
    }
  }

  private async readSyncStateFile(): Promise<SopSyncState | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.statePath, 'utf-8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      const lastSuccessAt = readIsoOrNull(record['lastSuccessAt']);
      const lastAttemptAt = readIsoOrNull(record['lastAttemptAt']);
      const lastError = typeof record['lastError'] === 'string' ? record['lastError'] : null;
      // 标志位与时间戳取或：任一为真即视为「曾经接入过云端」。
      // 只有时间戳（老数据）或只有标志位（时间字段损坏）都不该被降级成「从未接入」——
      // 后者宁可显示「已过期」（时间未知按最严重算），也不能说用户从未用过云端。
      const everSucceeded = lastSuccessAt !== null || record['everSucceeded'] === true;
      return { lastSuccessAt, lastAttemptAt, lastError, everSucceeded };
    } catch {
      return null;
    }
  }

  /**
   * 从 sync.log 最后一条记录回溯同步状态。
   *
   * logSync 只在成功路径调用（applyDiff / fetchFull / emergencyUpdate 之后），
   * 所以最后一条的时间戳就是「最近一次成功同步的真实本地时刻」。
   * 这比 version.json 的 publishedAt 准：后者是云端包发布时间，
   * 同步一个昨天发布的包会让 publishedAt 停在昨天，
   * 于是「刚刚同步成功」被算成「1 天前」而显示待更新。
   */
  private async inferSyncStateFromLog(): Promise<SopSyncState | null> {
    const entries = await this.readSyncLog();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const lastSuccessAt = readIsoOrNull(entries[i]?.timestamp);
      if (lastSuccessAt) {
        return { lastSuccessAt, lastAttemptAt: null, lastError: null, everSucceeded: true };
      }
    }
    return null;
  }

  /** 最后兜底：从 version.json 的 publishedAt 回溯（version.json 只在成功路径写入） */
  private async inferSyncStateFromVersion(): Promise<SopSyncState> {
    const version = await this.load();
    // publishedAt 类型上声明为 Date，但磁盘 JSON 读回来是字符串，两种都接受
    const lastSuccessAt = readIsoOrNull(version?.publishedAt);
    if (lastSuccessAt) {
      return {
        lastSuccessAt,
        lastAttemptAt: null,
        lastError: null,
        everSucceeded: true,
      };
    }
    return emptySyncState();
  }

  /**
   * 追加同步日志（写入失败不阻塞主流程）
   */
  async logSync(entry: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    try {
      await fs.promises.appendFile(this.logPath, line, 'utf-8');
    } catch {
      // 日志写入失败不阻塞主流程
    }
  }

  /**
   * 读取同步日志（逐行解析，坏行跳过；文件不存在返回空数组）
   */
  async readSyncLog(): Promise<SyncLogEntry[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.logPath, 'utf-8');
    } catch {
      return [];
    }
    const entries: SyncLogEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof (parsed as Record<string, unknown>)['timestamp'] === 'string'
        ) {
          entries.push(parsed as SyncLogEntry);
        }
      } catch {
        // 跳过损坏行
      }
    }
    return entries;
  }

  /**
   * 整体重写同步日志（维护裁剪用）
   */
  async writeSyncLog(entries: SyncLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const content = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await this.atomicWriteFile(this.logPath, content);
  }
}

/** 读取 ISO 时间字段：接受 Date 或可解析的日期字符串，其余（空串/非字符串/非法日期）一律 null */
function readIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}
