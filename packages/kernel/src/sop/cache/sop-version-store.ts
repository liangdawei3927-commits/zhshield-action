import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SopVersion } from '../_meta/sop-types';

export interface SyncLogEntry {
  timestamp: string;
  [key: string]: unknown;
}

/**
 * SopVersionStore — 本地版本号与同步日志存储
 *
 * 负责 version.json 的原子读写与 sync.log 追加。
 */
export class SopVersionStore {
  private readonly versionPath: string;
  private readonly logPath: string;

  constructor(cacheDir: string) {
    this.versionPath = path.join(cacheDir, 'version.json');
    this.logPath = path.join(cacheDir, 'sync.log');
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
