/**
 * 任务去重缺陷回归（task-manager-dedup.test.ts）
 *
 * 缺陷：TaskManager.start 仅按 kind + projectPath + status 去重，忽略 request。
 * 对 garbageClean / garbageRestore 这类「变更类」任务，第二次带不同载荷调用会
 * 命中旧任务并直接返回 → 新请求被静默丢弃，waitFor 拿到的是旧结果。
 *
 * 修复：去重必须同时比对「请求身份」（canonicalRequestKey）。此处覆盖纯函数与
 * 真实 TaskManager（注入 fake runner、getWindow=null）两端：
 * - 同载荷 → 复用同一任务；
 * - 异载荷 → 新建第二个任务，且 waitFor 返回新载荷对应的结果；
 * - 扫描类（request 为 undefined）保持既有合并语义。
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

import {
  TaskManager,
  canonicalRequestKey,
  findReusableTask,
  type TaskInfo,
  type TaskKind,
} from '../../electron/task-manager';

type FakeRunner = (
  task: TaskInfo,
  request: unknown,
  onProgress: (stage: string, message: string, pct: number) => void,
) => Promise<unknown>;

function makeManager(runner: FakeRunner): TaskManager {
  const runnerByKind: Record<TaskKind, FakeRunner> = {
    pipeline: runner,
    security: runner,
    garbage: runner,
    garbageClean: runner,
    garbageRestore: runner,
    performance: runner,
    guard: runner,
    refactor: runner,
  };
  return new TaskManager(runnerByKind, () => null);
}

function pendingRunner(): FakeRunner {
  return () => new Promise<unknown>(() => {});
}

describe('canonicalRequestKey — 稳定的请求身份键', () => {
  it('对象键序无关：{a,b} 与 {b,a} 得同一键（含嵌套）', () => {
    expect(canonicalRequestKey({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalRequestKey({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(canonicalRequestKey([{ a: 1, b: 2 }])).toBe(canonicalRequestKey([{ b: 2, a: 1 }]));
  });

  it('区分不同载荷', () => {
    expect(canonicalRequestKey({ n: 1 })).not.toBe(canonicalRequestKey({ n: 2 }));
    expect(canonicalRequestKey({ items: [{ id: 'a' }] })).not.toBe(
      canonicalRequestKey({ items: [{ id: 'b' }] }),
    );
  });

  it('undefined / null → 固定哨兵 null；对象内 undefined 属性与缺失等价', () => {
    expect(canonicalRequestKey(undefined)).toBe('null');
    expect(canonicalRequestKey(null)).toBe('null');
    expect(canonicalRequestKey({ a: undefined, b: 1 })).toBe(canonicalRequestKey({ b: 1 }));
  });

  it('数组顺序属于语义：顺序不同则键不同', () => {
    expect(canonicalRequestKey([1, 2])).toBe(canonicalRequestKey([1, 2]));
    expect(canonicalRequestKey([1, 2])).not.toBe(canonicalRequestKey([2, 1]));
  });
});

describe('findReusableTask — 纯谓词', () => {
  const active: TaskInfo = {
    id: 'x',
    kind: 'garbageClean',
    projectPath: '/p',
    status: 'running',
    progress: 0,
    startedAt: '',
  };
  const keys = new Map<string, string>([['x', 'K']]);

  it('命中：active + kind + path + requestKey 全等', () => {
    const queued: TaskInfo = { ...active, status: 'queued' };
    expect(findReusableTask([active], 'garbageClean', '/p', 'K', keys)).toBe(active);
    expect(findReusableTask([queued], 'garbageClean', '/p', 'K', keys)).toBe(queued);
  });

  it('未命中：kind / path / requestKey / 状态任一不符', () => {
    expect(findReusableTask([active], 'garbageRestore', '/p', 'K', keys)).toBeUndefined();
    expect(findReusableTask([active], 'garbageClean', '/other', 'K', keys)).toBeUndefined();
    expect(findReusableTask([active], 'garbageClean', '/p', 'OTHER', keys)).toBeUndefined();
    expect(findReusableTask([active], 'garbageClean', '/p', 'K', new Map())).toBeUndefined();
    expect(
      findReusableTask([{ ...active, status: 'done' }], 'garbageClean', '/p', 'K', keys),
    ).toBeUndefined();
    expect(
      findReusableTask([{ ...active, status: 'failed' }], 'garbageClean', '/p', 'K', keys),
    ).toBeUndefined();
    expect(
      findReusableTask([{ ...active, status: 'cancelled' }], 'garbageClean', '/p', 'K', keys),
    ).toBeUndefined();
  });
});

describe('TaskManager.start — 请求身份参与去重', () => {
  it('同载荷复用同一任务，异载荷新建任务（旧任务结果不被冒名顶替）', async () => {
    const mgr = makeManager(async (_t, request) => request);
    const A = { items: [{ id: 'a', path: '/a', size: 1, type: 'cache' }] };
    const B = { items: [{ id: 'b', path: '/b', size: 2, type: 'cache' }] };

    const t1 = mgr.start('garbageClean', '/p', A);
    const t1again = mgr.start('garbageClean', '/p', A);
    expect(t1again.id).toBe(t1.id);

    const t2 = mgr.start('garbageClean', '/p', B);
    expect(t2.id).not.toBe(t1.id);
    expect(mgr.list()).toHaveLength(2);

    // 关键回归：第二次带新载荷的调用返回新任务，waitFor 解析出新载荷的结果
    expect(await mgr.waitFor(t2.id)).toEqual(B);
    expect(await mgr.waitFor(t1.id)).toEqual(A);
  });

  it('运行中 + 排队中均按请求键复用', () => {
    const mgr = makeManager(pendingRunner());
    const a = mgr.start('garbageClean', '/p', { n: 1 });
    const b = mgr.start('garbageClean', '/p', { n: 2 });
    const c = mgr.start('garbageClean', '/p', { n: 3 });

    expect(a.status).toBe('running');
    expect(b.status).toBe('running');
    expect(c.status).toBe('queued');

    expect(mgr.start('garbageClean', '/p', { n: 3 }).id).toBe(c.id);
    expect(mgr.start('garbageClean', '/p', { n: 1 }).id).toBe(a.id);
    expect(mgr.start('garbageClean', '/p', { n: 2 }).id).toBe(b.id);
    expect(mgr.list()).toHaveLength(3);
  });

  it('扫描类（request undefined）保持既有合并语义', () => {
    const mgr = makeManager(pendingRunner());
    const s1 = mgr.start('garbage', '/p');
    const s2 = mgr.start('garbage', '/p');
    expect(s2.id).toBe(s1.id);
    expect(mgr.list()).toHaveLength(1);

    const p1 = mgr.start('performance', '/p');
    expect(mgr.start('performance', '/p').id).toBe(p1.id);
  });

  it('任务完成后不再复用（同载荷再次调用会新建）', async () => {
    const mgr = makeManager(async (_t, request) => request);
    const A = { batchId: 'batch-1' };
    const first = mgr.start('garbageRestore', '/p', A);
    await mgr.waitFor(first.id);

    const second = mgr.start('garbageRestore', '/p', A);
    expect(second.id).not.toBe(first.id);
  });

  it('取消后不再复用', () => {
    const mgr = makeManager(pendingRunner());
    const A = { batchId: 'batch-2' };
    const first = mgr.start('garbageRestore', '/p', A);
    expect(mgr.cancel(first.id)).toBe(true);

    const second = mgr.start('garbageRestore', '/p', A);
    expect(second.id).not.toBe(first.id);
  });
});

describe('结构性守卫 — start 必须经由请求身份去重', () => {
  it('task-manager.ts 的 start 引用了两个纯函数', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../electron/task-manager.ts'),
      'utf-8',
    );
    expect(src).toContain('canonicalRequestKey(');
    expect(src).toContain('findReusableTask(');
  });
});
