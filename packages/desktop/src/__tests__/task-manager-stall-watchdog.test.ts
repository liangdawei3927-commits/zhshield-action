/**
 * P0-2 回归：任务无进展看门狗（task-manager-stall-watchdog.test.ts）
 *
 * 缺陷：running 任务一旦卡死（deps/techdebt 直连执行器无内建超时，worker 兜底
 * 超时长 30 分钟），会占满 MAX_CONCURRENT 槽位，让后续任务永远「排队中」——
 * 界面上出现固定不动的「体检中 5%」僵尸，唯一出口是用户点「停止」。
 *
 * 修复：TaskManager 内建看门狗——running 任务超过 TASK_STALL_TIMEOUT_MS 没有
 * 任何 progress 心跳 → 强制标 failed（error=task.stalledTimeout）并释放槽位、
 * 放行排队任务；底层 Promise 稍后收尾时不得二次释放槽位或改写终态。
 *
 * 双自证（门禁铁律）：
 * - 真阳性：无心跳任务必被杀，排队任务被放行，waitFor 必 reject；
 * - 误报防护：持续心跳（间隔 < 阈值）的任务绝不误杀。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../electron/ipc-context', () => ({
  getMainWindow: () => null,
}));

vi.mock('../../electron/pipeline-host', () => ({
  runPipelineInWorker: vi.fn(),
  runRefactorInWorker: vi.fn(),
  runGuardInWorker: vi.fn(),
  runSecurityInWorker: vi.fn(),
  runGarbageScanInWorker: vi.fn(),
  runGarbageCleanInWorker: vi.fn(),
  runGarbageRestoreInWorker: vi.fn(),
  runPerformanceInWorker: vi.fn(),
  cancelJob: vi.fn(),
}));

import { TaskManager, TASK_STALL_TIMEOUT_MS, type TaskInfo, type TaskKind } from '../../electron/task-manager';
import { t } from '@zh/i18n';

type FakeRunner = (
  task: TaskInfo,
  request: unknown,
  onProgress: (stage: string, message: string, pct: number) => void,
) => Promise<unknown>;

function makeManager(runnerByKind: Partial<Record<TaskKind, FakeRunner>>): TaskManager {
  const fallback: FakeRunner = () => new Promise<unknown>(() => {});
  const full = {
    pipeline: fallback,
    security: fallback,
    garbage: fallback,
    garbageClean: fallback,
    garbageRestore: fallback,
    performance: fallback,
    guard: fallback,
    refactor: fallback,
    deps: fallback,
    techdebt: fallback,
    ...runnerByKind,
  } as Record<TaskKind, FakeRunner>;
  return new TaskManager(full, () => null);
}

/** 让 runTask 的 promise 微任务链跑完（fake timers 下状态才落位） */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('TaskManager 看门狗 — 无进展任务强制失败并放行队列（P0-2）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('真阳性：无心跳的 running 任务超时后被标 failed，排队任务被放行', async () => {
    // 两个槽位都被「永不返回、永不汇报进度」的任务占满 → 模拟僵尸占死队列
    const mgr = makeManager({
      pipeline: () => new Promise<unknown>(() => {}),
      garbage: () => new Promise<unknown>(() => {}),
      // refactor 排队中 → 看门狗杀掉占槽任务后应被放行并跑完
      refactor: async () => 'refactor-done',
    });

    const stalled1 = mgr.start('pipeline', '/p');
    const stalled2 = mgr.start('garbage', '/p');
    await flushMicrotasks();
    expect(stalled1.status).toBe('running');
    expect(stalled2.status).toBe('running');

    const queued = mgr.start('refactor', '/p');
    await flushMicrotasks();
    expect(queued.status).toBe('queued'); // 槽位被卡死任务占满

    // 推进时钟：跨过 30s 巡检间隔 × 多轮，直到超过 5 分钟无进展阈值
    await vi.advanceTimersByTimeAsync(TASK_STALL_TIMEOUT_MS + 60_000);

    expect(stalled1.status).toBe('failed');
    expect(stalled1.error).toBe(t('task.stalledTimeout', { minutes: 5 }));
    expect(stalled2.status).toBe('failed');
    // 排队任务被放行并完成——队列不再被僵尸占死
    expect(queued.status).toBe('done');
    expect(await mgr.waitFor(queued.id)).toBe('refactor-done');
  });

  it('waitFor 对被看门狗杀掉的任务 reject，错误含 stalledTimeout 文案', async () => {
    const mgr = makeManager({ pipeline: () => new Promise<unknown>(() => {}) });
    const task = mgr.start('pipeline', '/p');
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(TASK_STALL_TIMEOUT_MS + 60_000);

    await expect(mgr.waitFor(task.id)).rejects.toThrow(
      t('task.stalledTimeout', { minutes: 5 }),
    );
  });

  it('误报防护：持续心跳（间隔小于阈值）的任务不被误杀', async () => {
    // 每 4 分钟心跳一次（< 5 分钟阈值）→ 永不该被判卡死
    const heartbeatRunner: FakeRunner = (_task, _req, onProgress) =>
      new Promise<never>(() => {
        setInterval(() => onProgress('stage', 'still working', 0.5), 240_000);
      });
    const mgr = makeManager({ pipeline: heartbeatRunner });
    const task = mgr.start('pipeline', '/p');
    await flushMicrotasks();

    // 推进 12 分钟：经历 3 次心跳，任意时刻无进展间隔都 < 5 分钟
    await vi.advanceTimersByTimeAsync(12 * 60_000);

    expect(task.status).toBe('running');
    expect(task.error).toBeUndefined();
  });

  it('二次释放防护：看门狗杀掉任务后底层 Promise 才收尾，终态不被改写、槽位只减一次', async () => {
    let resolveRunner!: (v: unknown) => void;
    const mgr = makeManager({
      pipeline: () =>
        new Promise<unknown>((resolve) => {
          resolveRunner = resolve;
        }),
      garbage: async () => 'late-comer',
    });

    const stalled = mgr.start('pipeline', '/p');
    await flushMicrotasks();
    expect(stalled.status).toBe('running');

    await vi.advanceTimersByTimeAsync(TASK_STALL_TIMEOUT_MS + 60_000);
    expect(stalled.status).toBe('failed');

    // 底层 Promise 此时才 resolve：不得把 failed 改写成 done
    resolveRunner('too-late');
    await flushMicrotasks();
    expect(stalled.status).toBe('failed');

    // 槽位已释放：新任务能立即开跑（若二次扣减 running 会变负数、但新任务仍能跑；
    // 关键不变量是新任务不被阻塞）
    const next = mgr.start('garbage', '/p');
    await flushMicrotasks();
    expect(next.status).toBe('done');
  });

  it('看门狗只杀 running：queued 任务本身不因等待时长被误标失败', async () => {
    const mgr = makeManager({
      pipeline: () => new Promise<unknown>(() => {}),
      garbage: () => new Promise<unknown>(() => {}),
      refactor: async () => 'refactor-done',
    });
    mgr.start('pipeline', '/p');
    mgr.start('garbage', '/p');
    const queued = mgr.start('refactor', '/p');
    await flushMicrotasks();
    expect(queued.status).toBe('queued');

    await vi.advanceTimersByTimeAsync(TASK_STALL_TIMEOUT_MS + 60_000);
    // 两个无心跳任务都被杀，但 queued 任务是「被放行后正常跑完」，不是被标失败
    expect(mgr.list().filter((x) => x.status === 'failed')).toHaveLength(2);
    expect(queued.status).toBe('done');
  });
});
