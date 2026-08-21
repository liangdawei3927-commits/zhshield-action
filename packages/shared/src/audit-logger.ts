import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as os from 'node:os';
import { pipeline } from 'node:stream/promises';
import type { ToolId, ToolStatus, AuditLogEntry } from './types';

interface ToolExecutionData {
  tool: ToolId;
  version?: string;
  duration: number;
  fileCount: number;
  issueCount: number;
  status: ToolStatus;
  projectId: string;
}

interface GuardBlockData {
  hookType: string;
  reason: string;
  files: string[];
  ruleId?: string;
  operator: string;
  projectId: string;
  passed: boolean;
}

interface WhitelistGrantData {
  scope: string;
  target: string;
  ruleId?: string;
  reason: string;
  operator: string;
  projectId: string;
}

interface ExperienceRecordData {
  type: string;
  ruleId: string;
  pattern: string;
  feedback: string;
  projectId: string;
}

interface AuditQuery {
  action?: string;
  tool?: string;
  projectId?: string;
  fromDate?: Date;
  toDate?: Date;
}

const LOG_CATEGORIES = ['tool-execution', 'guard-block', 'whitelist', 'experience'] as const;

export class AuditLogger {
  private basePath: string;

  constructor() {
    this.basePath = path.join(os.homedir(), '.zhshield', 'audit');
  }

  private getLogPath(category: string): string {
    const dateStr = new Date().toISOString().slice(0, 10);
    return path.join(this.basePath, category, `${dateStr}.jsonl`);
  }

  private async logToFile(category: string, entry: Record<string, unknown>): Promise<void> {
    const logPath = this.getLogPath(category);
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    await fs.promises.appendFile(logPath, line, 'utf-8');
  }

  async logToolExecution(data: ToolExecutionData): Promise<void> {
    await this.logToFile('tool-execution', {
      action: 'tool-executed',
      ...data,
    });
  }

  async logGuardBlock(data: GuardBlockData): Promise<void> {
    await this.logToFile('guard-block', {
      action: data.passed ? 'guard-passed' : 'guard-blocked',
      ...data,
    });
  }

  async logWhitelistGrant(data: WhitelistGrantData): Promise<void> {
    await this.logToFile('whitelist', {
      action: 'whitelist-granted',
      ...data,
    });
  }

  async logExperienceRecord(data: ExperienceRecordData): Promise<void> {
    await this.logToFile('experience', {
      action: 'experience-recorded',
      ...data,
    });
  }

  async query(filters: AuditQuery): Promise<AuditLogEntry[]> {
    const allEntries: AuditLogEntry[] = [];

    for (const category of LOG_CATEGORIES) {
      await this.collectCategoryEntries(category, filters, allEntries);
    }

    return allEntries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  /** 列出某类别目录下的日志文件，目录不存在时返回 null */
  private async listCategoryFiles(category: string): Promise<string[] | null> {
    const dir = path.join(this.basePath, category);
    try {
      await fs.promises.access(dir);
    } catch {
      return null;
    }
    return fs.promises.readdir(dir);
  }

  private isOutsideDateRange(file: string, filters: AuditQuery): boolean {
    if (!filters.fromDate && !filters.toDate) return false;
    const fileDate = file.replace('.jsonl', '');
    if (filters.fromDate && fileDate < filters.fromDate.toISOString().slice(0, 10)) return true;
    if (filters.toDate && fileDate > filters.toDate.toISOString().slice(0, 10)) return true;
    return false;
  }

  /** 读取类别下全部日志并收集符合条件的条目 */
  private async collectCategoryEntries(
    category: string,
    filters: AuditQuery,
    allEntries: AuditLogEntry[],
  ): Promise<void> {
    const files = await this.listCategoryFiles(category);
    if (!files) return;

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      if (this.isOutsideDateRange(file, filters)) continue;

      const content = await fs.promises.readFile(path.join(this.basePath, category, file), 'utf-8');
      this.collectMatchingEntries(content, filters, allEntries);
    }
  }

  private collectMatchingEntries(content: string, filters: AuditQuery, allEntries: AuditLogEntry[]): void {
    for (const line of content.trim().split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as AuditLogEntry;
        if (filters.action && entry.action !== filters.action) continue;
        if (filters.tool && entry.tool !== filters.tool) continue;
        if (filters.projectId && entry.projectId !== filters.projectId) continue;
        allEntries.push(entry);
      } catch {
        continue;
      }
    }
  }

  getStoragePath(): string {
    return this.basePath;
  }

  // ─── 日志清理与压缩 ──────────────────────────────────────

  /** 判断日志文件是否早于 cutoff 时间戳 */
  private isExpiredLog(file: string, cutoff: number): boolean {
    if (!file.endsWith('.jsonl')) return false;
    const fileTime = new Date(file.replace('.jsonl', '')).getTime();
    return !isNaN(fileTime) && fileTime < cutoff;
  }

  /** 删除类别下过期日志并返回删除数量 */
  private async removeExpiredLogs(category: string, cutoff: number): Promise<number> {
    const files = await this.listCategoryFiles(category);
    if (!files) return 0;

    let removed = 0;
    for (const file of files) {
      if (!this.isExpiredLog(file, cutoff)) continue;
      await fs.promises.rm(path.join(this.basePath, category, file), { force: true });
      removed++;
    }
    return removed;
  }

  /** 压缩类别下过期日志并返回压缩数量 */
  private async compressCategoryLogs(category: string, cutoff: number): Promise<number> {
    const files = await this.listCategoryFiles(category);
    if (!files) return 0;

    let compressed = 0;
    for (const file of files) {
      if (!this.isExpiredLog(file, cutoff)) continue;
      const sourcePath = path.join(this.basePath, category, file);
      if (await this.compressFile(sourcePath, sourcePath + '.gz')) {
        compressed++;
      }
    }
    return compressed;
  }

  /**
   * 清理超过 retentionDays 天的原始日志文件
   * 已压缩的 .gz 文件不受影响
   */
  async cleanup(retentionDays = 365): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const category of LOG_CATEGORIES) {
      removed += await this.removeExpiredLogs(category, cutoff);
    }

    return removed;
  }

  /**
   * 压缩超过 compressDays 天的 .jsonl 日志文件为 .jsonl.gz
   * 压缩后删除原始文件
   */
  async compressOldLogs(compressDays = 30): Promise<number> {
    const cutoff = Date.now() - compressDays * 24 * 60 * 60 * 1000;
    let compressed = 0;

    for (const category of LOG_CATEGORIES) {
      compressed += await this.compressCategoryLogs(category, cutoff);
    }

    return compressed;
  }

  private async compressFile(sourcePath: string, gzPath: string): Promise<boolean> {
    try {
      await fs.promises.access(gzPath);
      return false;
    } catch {
      // gz 不存在则允许压缩
    }

    try {
      await pipeline(
        fs.createReadStream(sourcePath),
        zlib.createGzip(),
        fs.createWriteStream(gzPath),
      );
      await fs.promises.rm(sourcePath, { force: true });
      return true;
    } catch {
      // 压缩失败时清理不完整的 .gz 文件
      await fs.promises.rm(gzPath, { force: true }).catch(() => {});
      return false;
    }
  }
}
