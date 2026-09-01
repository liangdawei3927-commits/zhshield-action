import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveApiBase } from './api-base';
import { HttpError, withRetry } from './retry';

// ─── 类型 ────────────────────────────────────────────────────

export type ExperienceType = 'false_positive' | 'true_positive' | 'fix_suggestion' | 'new_pattern';

export interface ExperienceRecord {
  /** 回写类型 */
  type: ExperienceType;

  /** 关联规则 ID */
  ruleId: string;

  /** 关联工具 ID */
  toolId: string;

  /** 代码模式/文件路径 */
  codePattern?: string;

  /** 用户反馈/描述 */
  description: string;

  /** 修复步骤（fix_suggestion 类型） */
  fixSteps?: string;

  /** 项目标识 */
  projectId: string;

  /** 时间戳（ISO 8601） */
  timestamp: string;
}

export interface ExperienceReportResult {
  sent: number;
  queued: number;
  failed: number;
}

// ─── ExperienceReporter ──────────────────────────────────────

/**
 * ExperienceReporter — 经验回写管理器
 *
 * 桌面端 → 云端大脑的经验回写：
 * - 误报记录：用户标记「误报」→ 校准规则，降低误报率
 * - 真阳性确认：用户确认「这是问题」→ 强化规则，提高置信度
 * - 修复方案：用户成功修复问题 → 生成修复建议
 * - 新问题模式：用户发现新问题 → 扩展规则库
 */
export class ExperienceReporter {
  private queuePath: string;
  private remoteUrl: string;
  private batchSize: number;
  private isOnline: boolean;
  private pendingQueue: ExperienceRecord[];
  private dirty: boolean;

  constructor(options?: { remoteUrl?: string; batchSize?: number }) {
    this.queuePath = path.join(os.homedir(), '.zhshield', 'experience-queue.json');
    this.remoteUrl = options?.remoteUrl ?? `${resolveApiBase()}/experience`;
    this.batchSize = options?.batchSize ?? 20;
    this.isOnline = true;
    this.pendingQueue = [];
    this.dirty = false;
  }

  // ─── 初始化 ────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.queuePath), { recursive: true });
    await this.loadQueue();
  }

  // ─── 提交经验记录 ──────────────────────────────────────────

  async submit(record: Omit<ExperienceRecord, 'timestamp'>): Promise<void> {
    const fullRecord: ExperienceRecord = {
      ...record,
      timestamp: new Date().toISOString(),
    };

    this.pendingQueue.push(fullRecord);
    this.dirty = true;

    // 达到批处理阈值 → 尝试发送
    if (this.pendingQueue.length >= this.batchSize) {
      await this.flush();
    } else {
      await this.persistQueue();
    }
  }

  // ─── 批量提交 ──────────────────────────────────────────────

  async submitBatch(records: Omit<ExperienceRecord, 'timestamp'>[]): Promise<void> {
    const now = new Date().toISOString();
    for (const record of records) {
      this.pendingQueue.push({ ...record, timestamp: now });
    }
    this.dirty = true;

    if (this.pendingQueue.length >= this.batchSize) {
      await this.flush();
    } else {
      await this.persistQueue();
    }
  }

  // ─── 刷新队列（发送所有待发记录） ──────────────────────────

  async flush(): Promise<ExperienceReportResult> {
    if (!this.isOnline || this.pendingQueue.length === 0) {
      return { sent: 0, queued: this.pendingQueue.length, failed: 0 };
    }
    const batch = [...this.pendingQueue];
    const result: ExperienceReportResult = { sent: 0, queued: 0, failed: 0 };
    const allSucceeded = await this.sendChunks(batch, result);
    if (allSucceeded) {
      this.pendingQueue = [];
    }
    this.dirty = this.pendingQueue.length > 0;
    await this.persistQueue();
    result.queued = this.pendingQueue.length;
    return result;
  }

  private async sendChunks(
    batch: ExperienceRecord[],
    result: ExperienceReportResult,
  ): Promise<boolean> {
    let allSucceeded = true;
    const chunks: ExperienceRecord[][] = [];
    for (let i = 0; i < batch.length; i += this.batchSize) {
      chunks.push(batch.slice(i, i + this.batchSize));
    }
    const outcomes = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const ok = await this.sendBatch(chunk);
          return { ok, chunkLength: chunk.length };
        } catch {
          return { ok: false, chunkLength: chunk.length };
        }
      }),
    );
    for (const { ok, chunkLength } of outcomes) {
      if (ok) {
        result.sent += chunkLength;
      } else {
        result.failed += chunkLength;
        allSucceeded = false;
      }
    }
    return allSucceeded;
  }

  // ─── 查询 ──────────────────────────────────────────────────

  getQueueLength(): number {
    return this.pendingQueue.length;
  }

  peekQueue(limit = 10): ExperienceRecord[] {
    return this.pendingQueue.slice(0, limit);
  }

  // ─── 网络状态 ──────────────────────────────────────────────

  setOnline(online: boolean): void {
    this.isOnline = online;
  }

  // ─── 私有 ──────────────────────────────────────────────────

  private async sendBatch(records: ExperienceRecord[]): Promise<boolean> {
    // 瞬态失败（网络故障/429/5xx）由 withRetry 退避重试；其余 4xx 直接失败
    await withRetry(async () => {
      const res = await fetch(this.remoteUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new HttpError(res.status);
      return res;
    });
    return true;
  }

  private async loadQueue(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.queuePath, 'utf-8');
      const data = JSON.parse(raw);
      this.pendingQueue = Array.isArray(data) ? data : [];
    } catch {
      this.pendingQueue = [];
    }
    this.dirty = false;
  }

  private async persistQueue(): Promise<void> {
    if (!this.dirty) return;
    await fs.promises.writeFile(
      this.queuePath,
      JSON.stringify(this.pendingQueue, null, 2),
      'utf-8',
    );
    this.dirty = false;
  }
}
