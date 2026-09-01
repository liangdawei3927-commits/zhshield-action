import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface AuditEntry {
  id: string;
  timestamp: Date;
  action: string;
  userId: string;
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface AuditQuery {
  startDate?: Date;
  endDate?: Date;
  action?: string;
  userId?: string;
  limit?: number;
}

export interface AuditStats {
  totalEntries: number;
  byAction: Record<string, number>;
  byUser: Record<string, number>;
  dateRange: { earliest: Date; latest: Date } | null;
}

const DEDUP_WINDOW_MS = 1000;

export class AuditLogger {
  private logDir: string;
  private maxFileSize = 10 * 1024 * 1024; // 10MB
  /** 写入互斥锁：保证哈希链读取与追加写入串行执行，失败不得污染后续写入 */
  private writeLock: Promise<void> = Promise.resolve();

  constructor(logDir?: string) {
    this.logDir = logDir ?? join(process.cwd(), '.zhshield', 'audit');
  }

  /**
   * 记录审计日志
   */
  async log(action: string, userId: string, details: Record<string, unknown>): Promise<AuditEntry> {
    const entries = await this.loadAllEntries();
    const last = entries.at(-1);
    if (
      last !== undefined &&
      last.action === action &&
      last.userId === userId &&
      JSON.stringify(last.details) === JSON.stringify(details) &&
      Date.now() - last.timestamp.getTime() < DEDUP_WINDOW_MS
    ) {
      return last;
    }

    const write = this.writeLock.then(() => this.createAndAppend(action, userId, details));
    this.writeLock = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  /**
   * 查询审计日志
   */
  async query(filter: AuditQuery): Promise<AuditEntry[]> {
    const entries = await this.loadAllEntries();
    return entries.filter((e) => this.matchesFilter(e, filter)).slice(0, filter.limit ?? 1000);
  }

  /**
   * 验证审计日志完整性
   */
  async verifyIntegrity(): Promise<{ valid: boolean; brokenAt?: string }> {
    const entries = await this.loadAllEntries();
    let previousHash = '';

    for (const entry of entries) {
      if (entry.previousHash !== previousHash) {
        return { valid: false, brokenAt: entry.id };
      }
      const { hash: _hash, ...entryWithoutHash } = entry;
      const expectedHash = this.computeHash(entryWithoutHash);
      if (entry.hash !== expectedHash) {
        return { valid: false, brokenAt: entry.id };
      }
      previousHash = entry.hash;
    }

    return { valid: true };
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<AuditStats> {
    const entries = await this.loadAllEntries();
    if (entries.length === 0) {
      return { totalEntries: 0, byAction: {}, byUser: {}, dateRange: null };
    }

    const byAction: Record<string, number> = {};
    const byUser: Record<string, number> = {};
    let earliest = entries[0]!.timestamp;
    let latest = entries[0]!.timestamp;

    for (const entry of entries) {
      byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
      byUser[entry.userId] = (byUser[entry.userId] ?? 0) + 1;
      if (entry.timestamp < earliest) earliest = entry.timestamp;
      if (entry.timestamp > latest) latest = entry.timestamp;
    }

    return { totalEntries: entries.length, byAction, byUser, dateRange: { earliest, latest } };
  }

  // --- Private helpers ---

  /** 仅在持有 writeLock 时调用，否则并发下会计算出相同的链尾哈希 */
  private async createAndAppend(
    action: string,
    userId: string,
    details: Record<string, unknown>,
  ): Promise<AuditEntry> {
    const previousHash = await this.getLastHash();
    const entry: AuditEntry = {
      id: this.generateId(),
      timestamp: new Date(),
      action,
      userId,
      details,
      previousHash,
      hash: '', // computed below
    };
    entry.hash = this.computeHash(entry);

    await this.appendEntry(entry);
    return entry;
  }

  private generateId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private computeHash(entry: Omit<AuditEntry, 'hash'>): string {
    const data = `${entry.id}${entry.timestamp.toISOString()}${entry.action}${entry.userId}${JSON.stringify(entry.details)}${entry.previousHash}`;
    return createHash('sha256').update(data).digest('hex');
  }

  private async getLastHash(): Promise<string> {
    const entries = await this.loadAllEntries();
    return entries.length > 0 ? entries.at(-1)!.hash : '';
  }

  private async appendEntry(entry: AuditEntry): Promise<void> {
    try {
      await fs.promises.access(this.logDir);
    } catch {
      await fs.promises.mkdir(this.logDir, { recursive: true });
    }

    const currentFile = this.getCurrentLogFile();
    const line = JSON.stringify(entry) + '\n';
    await fs.promises.appendFile(currentFile, line, 'utf-8');
  }

  private getCurrentLogFile(): string {
    const files = existsSync(this.logDir)
      ? readdirSync(this.logDir)
          .filter((f) => f.endsWith('.jsonl'))
          .sort()
      : [];

    if (files.length === 0) return join(this.logDir, 'audit-001.jsonl');

    const lastFile = join(this.logDir, files.at(-1)!);
    const stats = statSync(lastFile);

    if (stats.size >= this.maxFileSize) {
      const nextNum = files.length + 1;
      return join(this.logDir, `audit-${String(nextNum).padStart(3, '0')}.jsonl`);
    }

    return lastFile;
  }

  private async loadAllEntries(): Promise<AuditEntry[]> {
    try {
      await fs.promises.access(this.logDir);
    } catch {
      return [];
    }

    const files = (await fs.promises.readdir(this.logDir))
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    const entries: AuditEntry[] = [];

    for (const file of files) {
      const content = await fs.promises.readFile(join(this.logDir, file), 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditEntry;
          entry.timestamp = new Date(entry.timestamp);
          entries.push(entry);
        } catch {
          /* skip malformed lines */
        }
      }
    }

    return entries;
  }

  private matchesFilter(entry: AuditEntry, filter: AuditQuery): boolean {
    if (filter.startDate && entry.timestamp < filter.startDate) return false;
    if (filter.endDate && entry.timestamp > filter.endDate) return false;
    if (filter.action && entry.action !== filter.action) return false;
    if (filter.userId && entry.userId !== filter.userId) return false;
    return true;
  }
}
