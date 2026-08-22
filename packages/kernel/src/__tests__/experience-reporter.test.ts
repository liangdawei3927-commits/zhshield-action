import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 经验回写队列文件路径硬编码为 ~/.zhshield/experience-queue.json，无法注入，
// 故用内存 fs 隔离测试，避免污染用户主目录。
const { memfs } = vi.hoisted(() => ({ memfs: new Map<string, string>() }));

vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (p: unknown) => {
      const key = String(p);
      if (!memfs.has(key)) {
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      }
      return memfs.get(key);
    }),
    writeFile: vi.fn(async (p: unknown, c: unknown) => {
      memfs.set(String(p), String(c));
    }),
  },
}));

import { ExperienceReporter } from '../sop/sync/experience-reporter';
import type { ExperienceRecord } from '../sop/sync/experience-reporter';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T.+Z$/;

type RecordInput = Omit<ExperienceRecord, 'timestamp'>;

function makeRecord(over: Partial<RecordInput> = {}): RecordInput {
  return {
    type: 'false_positive',
    ruleId: 'r-1',
    toolId: 'eslint',
    description: '误报',
    projectId: 'p-1',
    ...over,
  };
}

function makeResponse(ok: boolean, status = ok ? 200 : 500): Response {
  return { ok, status, headers: new Headers() } as unknown as Response;
}

describe('ExperienceReporter', () => {
  let reporter: ExperienceReporter;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    memfs.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    reporter = new ExperienceReporter({ batchSize: 3 });
    await reporter.initialize();
  });

  // ─── 初始化 / 入队 ───────────────────────────────────────
  it('initialize 后队列为空（无历史文件）', () => {
    expect(reporter.getQueueLength()).toBe(0);
  });

  it('submit 未达 batchSize 应持久化但不发送', async () => {
    await reporter.submit(makeRecord());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reporter.getQueueLength()).toBe(1);
  });

  it('submit 后记录应带 ISO 时间戳', async () => {
    await reporter.submit(makeRecord());
    const [rec] = reporter.peekQueue();
    expect(rec.timestamp).toMatch(ISO_TIMESTAMP);
  });

  it('submit 达到 batchSize 应触发 flush 并发送', async () => {
    fetchMock.mockResolvedValue(makeResponse(true));
    await reporter.submit(makeRecord());
    await reporter.submit(makeRecord());
    await reporter.submit(makeRecord()); // 达到 batchSize=3 → flush
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reporter.getQueueLength()).toBe(0);
  });

  // ─── flush ───────────────────────────────────────────────
  it('空队列 flush 应返回全 0', async () => {
    expect(await reporter.flush()).toEqual({ sent: 0, queued: 0, failed: 0 });
  });

  it('flush 成功应清空队列并返回 sent 计数', async () => {
    fetchMock.mockResolvedValue(makeResponse(true));
    await reporter.submit(makeRecord());
    await reporter.submit(makeRecord());
    const r = await reporter.flush();
    expect(r).toEqual({ sent: 2, queued: 0, failed: 0 });
    expect(reporter.getQueueLength()).toBe(0);
  });

  it('flush 失败（5xx）应退避重试至多 3 次后计入 failed 并保留队列', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeResponse(false));
    await reporter.submit(makeRecord());
    await reporter.submit(makeRecord());
    const pending = reporter.flush();
    const assertion = expect(pending).resolves.toEqual({ sent: 0, queued: 2, failed: 2 });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3); // 5xx 瞬态 → 重试满 3 次
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(2);
    expect(reporter.getQueueLength()).toBe(2);
    await assertion;
  });

  it('flush 对 4xx 客户端错误不重试，直接计入 failed', async () => {
    fetchMock.mockResolvedValue(makeResponse(false, 400));
    await reporter.submit(makeRecord());
    const r = await reporter.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.failed).toBe(1);
    expect(r.queued).toBe(1);
  });

  it('flush 网络异常应退避重试至多 3 次后计入 failed 并保留队列', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError('network down'));
    await reporter.submit(makeRecord());
    const pending = reporter.flush();
    const assertion = expect(pending).resolves.toEqual({ sent: 0, queued: 1, failed: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.failed).toBe(1);
    expect(r.queued).toBe(1);
    await assertion;
  });

  it('离线时 flush 不发送，返回 queued 计数', async () => {
    reporter.setOnline(false);
    await reporter.submit(makeRecord());
    await reporter.submit(makeRecord());
    const r = await reporter.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: 0, queued: 2, failed: 0 });
  });

  // ─── 批量 / 分块 ─────────────────────────────────────────
  it('submitBatch 超过 batchSize 应分块发送', async () => {
    fetchMock.mockResolvedValue(makeResponse(true));
    await reporter.submitBatch([
      makeRecord({ ruleId: 'a' }),
      makeRecord({ ruleId: 'b' }),
      makeRecord({ ruleId: 'c' }),
      makeRecord({ ruleId: 'd' }),
      makeRecord({ ruleId: 'e' }),
    ]); // 5 条，batchSize=3 → flush 时分两块（3+2）
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reporter.getQueueLength()).toBe(0);
  });

  it('submitBatch 应以同一时间戳入队', async () => {
    await reporter.submitBatch([makeRecord(), makeRecord()]);
    const [r1, r2] = reporter.peekQueue(2);
    expect(r1.timestamp).toBe(r2.timestamp);
  });

  // ─── 查询 ────────────────────────────────────────────────
  it('peekQueue 应返回前 N 条且不修改队列', async () => {
    await reporter.submit(makeRecord({ ruleId: 'a' }));
    await reporter.submit(makeRecord({ ruleId: 'b' }));
    const peek = reporter.peekQueue(1);
    expect(peek).toHaveLength(1);
    expect(peek[0].ruleId).toBe('a');
    expect(reporter.getQueueLength()).toBe(2);
  });

  // ─── 持久化往返 ──────────────────────────────────────────
  it('队列应在 persist/load 间往返（重启恢复）', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeResponse(false)); // 发送失败 → 保留
    await reporter.submit(makeRecord({ ruleId: 'persist-1' }));
    const flushPromise = reporter.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await flushPromise;
    expect(result.failed).toBe(1); // 重试满 3 次后仍失败 → 保留队列
    vi.useRealTimers();

    // 模拟重启：新实例读取同一队列文件（内存 fs 共享）
    const reborn = new ExperienceReporter({ batchSize: 3 });
    await reborn.initialize();
    expect(reborn.getQueueLength()).toBe(1);
    expect(reborn.peekQueue()[0].ruleId).toBe('persist-1');
  });
});
