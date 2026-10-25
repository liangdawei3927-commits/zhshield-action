/**
 * 任务取消必须真的到达执行器（task-cancel-reach-executor.test.ts）
 *
 * 缺陷（2026-10-25 实查）：取消能力「齐备但接缝断裂」——
 *   1. `TaskManager.cancel()` 只调 `cancelJob(task.id)`，而 worker 内部
 *      `runningJobs` 的 key 是 `dispatchJob` 自己生成的 job id
 *      （`pipeline-<Date.now()>-<host 自己的 seq>`），与 `task.id`
 *      （`pipeline-<Date.now()>-<Manager 的 seq>`）是两套序号 ⇒ 消息到达 worker
 *      后 `runningJobs.get()` 返回 undefined，静默什么也没做。
 *   2. `cancel()` 的 running 分支从不 `settle()` 等待方，于是 `waitFor` 挂到
 *      任务自然结束才返回；若执行器卡住，IPC 永不返回，页面一直转圈。
 *   3. deps/techdebt 不走 pipeline-host，没有可中断的执行器（只能丢弃结果）。
 *
 * 这里用注入的 fake 执行器锁住三件事：
 *   A. 任务身份必须随调用一起送到执行器（cancelKey），否则无从翻译；
 *   B. `cancel(id)` 必须通知执行器，且必须**立刻**让等待方拿到取消错误；
 *   C. 取消后执行器即使晚些 resolve，也不许把状态改回 done。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../electron/ipc/engines-deps', () => ({ runDepsHandler: vi.fn() }));
vi.mock('../../electron/ipc/engines-techdebt', () => ({ runTechDebtHandler: vi.fn() }));

import * as host from '../../electron/pipeline-host';
import { buildTaskManager } from '../../electron/task-manager';

/** 永不 settle 的 promise：模拟"正在跑、还没结束"的执行器 */
function neverSettles(): Promise<unknown> {
  return new Promise<unknown>(() => undefined);
}

/** 让 microtask/macrotask 队列排空 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('任务身份必须送到执行器', () => {
  it('启动 pipeline 时，task.id 出现在执行器调用参数里（否则取消无从翻译）', async () => {
    vi.mocked(host.runPipelineInWorker).mockReturnValue(neverSettles());
    const manager = buildTaskManager();

    const task = manager.start('pipeline', '/tmp/proj');
    await vi.waitFor(() => expect(host.runPipelineInWorker).toHaveBeenCalledTimes(1));

    const args = vi.mocked(host.runPipelineInWorker).mock.calls[0] as unknown[];
    expect(
      args,
      `执行器收到的参数里没有 task.id=${task.id}，取消消息无法翻译到内部 job`,
    ).toContain(task.id);
  });

  it('启动 security 时同样带 task.id', async () => {
    vi.mocked(host.runSecurityInWorker).mockReturnValue(neverSettles());
    const manager = buildTaskManager();

    const task = manager.start('security', '/tmp/proj');
    await vi.waitFor(() => expect(host.runSecurityInWorker).toHaveBeenCalledTimes(1));

    const args = vi.mocked(host.runSecurityInWorker).mock.calls[0] as unknown[];
    expect(args).toContain(task.id);
  });
});

describe('取消要立刻生效', () => {
  it('cancel(id) 必须通知执行器', async () => {
    vi.mocked(host.runPipelineInWorker).mockReturnValue(neverSettles());
    const manager = buildTaskManager();

    const task = manager.start('pipeline', '/tmp/proj');
    await vi.waitFor(() => expect(host.runPipelineInWorker).toHaveBeenCalledTimes(1));

    expect(manager.cancel(task.id)).toBe(true);
    expect(host.cancelJob).toHaveBeenCalledWith(task.id);
  });

  it('等待方在点击停止的当下就拿到取消错误，而不是等任务自然结束', async () => {
    vi.mocked(host.runPipelineInWorker).mockReturnValue(neverSettles());
    const manager = buildTaskManager();

    const task = manager.start('pipeline', '/tmp/proj');
    await vi.waitFor(() => expect(host.runPipelineInWorker).toHaveBeenCalledTimes(1));

    const waiting = manager.waitFor(task.id);
    manager.cancel(task.id);

    // 若 cancel 不 settle，这里会挂到测试超时 —— 正是「点了停止没反应」的形态
    await expect(waiting).rejects.toThrow(/cancel/i);
  });

  it('取消后执行器晚到的结果不得把状态改回 done', async () => {
    let finish: ((v: unknown) => void) | undefined;
    vi.mocked(host.runPipelineInWorker).mockReturnValue(
      new Promise<unknown>((resolve) => {
        finish = resolve;
      }),
    );
    const manager = buildTaskManager();

    const task = manager.start('pipeline', '/tmp/proj');
    await vi.waitFor(() => expect(host.runPipelineInWorker).toHaveBeenCalledTimes(1));

    manager.cancel(task.id);
    finish?.({ ok: true });
    await flush();

    expect(manager.get(task.id)?.status).toBe('cancelled');
  });
});

describe('排队中的任务取消', () => {
  it('排队任务取消后不占用并发槽、也不会被执行', async () => {
    // 并发上限 2：先用两个不同 kind 占满
    vi.mocked(host.runPipelineInWorker).mockReturnValue(neverSettles());
    vi.mocked(host.runSecurityInWorker).mockReturnValue(neverSettles());
    const manager = buildTaskManager();

    manager.start('pipeline', '/tmp/a');
    manager.start('security', '/tmp/b');
    await flush();

    // 第三个必然排队（同 kind 同项目会被去重，所以换项目）
    const queued = manager.start('guard', '/tmp/c');
    expect(queued.status).toBe('queued');

    expect(manager.cancel(queued.id)).toBe(true);
    expect(manager.get(queued.id)?.status).toBe('cancelled');

    await flush();
    expect(host.runGuardInWorker).not.toHaveBeenCalled();
  });
});
