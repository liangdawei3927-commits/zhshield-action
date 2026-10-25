/**
 * 用户点「停止」后，页面不得出现「体检失败」+ 按钮下方那行红色错误文案。
 *
 * ## 缺陷实锤（2026-10-26 用户截图实锤，非推断）
 * 用户在「项目体检」页点停止，页面变成「体检失败」，按钮下方顶出一行红色
 * `[cancelled] 任务已取消`。红字里带 `[cancelled]` 标记 ⇒ 它**不是** i18n 渲染的
 * 文案，而是**主进程错误消息原文**；标题是「体检失败」⇒ 走的是 failure 分支，
 * 不是 catch 分支。
 *
 * 真凶（主进程 electron/ipc/engines.ts 的 handler 把取消吞成"失败结果"）：
 *   - `runPipelineHandler` 的 catch 里 `return createReport({ error: err.message })`
 *     ⇒ 渲染层 `runPipeline` 拿到的是 **resolve**，不是 reject
 *     ⇒ 渲染层的 `isCancelledError` 守卫（在 catch 里）**根本不触发**
 *     ⇒ `toInspectOutcome` 判 failed ⇒ `inspect-logic` 落失败页 ⇒ 红字上屏。
 *   - 其余 handler（guard / garbage / security / performance）吞成**空报告**，
 *     同样是把用户的主动操作说成"扫完了而且很干净"。
 *
 * ## 修复
 * 取消必须**原样抛给渲染层**，由 services/cancel-error.ts 静默处理（不落失败页、
 * 保留已有报告）。真实故障仍走各 handler 既有的降级兜底，行为不变。
 *
 * ## 本文件锁住三条不变量
 *   A. `rethrowIfCancelled` 判据：取消必抛、真实故障不抛（纯函数，无需 mock）；
 *   B. **行为级**：真的走 IPC 注册 → handler → 渲染层，取消必须 reject 到渲染层，
 *      且**不得**变成带 error 的失败报告（真阳性）；
 *   C. 真实故障仍然降级兜底，不许因修了取消而把真故障也抛出去（误报防护）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── 主进程依赖图裁剪：只留「取消传播」这条链要用的东西 ────────────────────
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('../../electron/ipc-context', () => ({
  getMainWindow: () => null,
  getScoring: vi.fn(),
  sendProgress: vi.fn(),
}));

vi.mock('../../electron/zh-diagnostics', () => ({
  persistDiagnostics: vi.fn(async () => '/tmp/diagnostics.json'),
  persistDiagnosticsFromEntries: vi.fn(async () => undefined),
  normalizeGuardSource: vi.fn(() => []),
  normalizePerformanceData: vi.fn(() => []),
}));

vi.mock('../../electron/ipc/dashboard-state', () => ({ updateDashboardState: vi.fn() }));

vi.mock('../../electron/ai-auto-fix', () => ({
  shouldAutoFix: vi.fn(() => false),
  countFixableIssues: vi.fn(() => ({ error: 0, warning: 0 })),
  resolveOpenCodeBin: vi.fn(() => null),
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

vi.mock('../../electron/profile-host', () => ({
  detectProfileInWorker: vi.fn(),
  collectExposedFilesInWorker: vi.fn(),
}));

vi.mock('../../electron/ipc/engines-scoring', () => ({
  ResolvedPipelineReports: class {},
  probeProjectProfile: vi.fn(),
  computePipelineHealthScore: vi.fn(() => 0),
  scorePipelineModules: vi.fn(() => []),
  generateReportSummaryHandler: vi.fn(),
  getScoreHandler: vi.fn(),
  getScoreHistoryHandler: vi.fn(),
  getDomainScoreHandler: vi.fn(),
  getHealthOverviewHandler: vi.fn(),
  getDomainReportHandler: vi.fn(),
  runProfileHandler: vi.fn(),
  getProfileHandler: vi.fn(),
}));

vi.mock('../../electron/ipc/domain-reports', () => ({
  saveDomainReportHandler: vi.fn(),
  getSavedDomainReportHandler: vi.fn(),
  getDomainSnapshotRawHandler: vi.fn(),
  hasDomainResultHandler: vi.fn(),
}));

vi.mock('../../electron/ipc/domain-history-ipc', () => ({
  getDomainScanBlobHandler: vi.fn(),
  getLatestDomainScanHandler: vi.fn(),
  listDomainHistoryHandler: vi.fn(),
}));

vi.mock('../../electron/ipc/engines-deps', () => ({
  runDepsHandler: vi.fn(),
  depsRelockBaselineHandler: vi.fn(),
}));

vi.mock('../../electron/ipc/engines-techdebt', () => ({ runTechDebtHandler: vi.fn() }));

vi.mock('../../electron/ipc/report-format', () => ({
  toGuardReportData: vi.fn(() => ({})),
  toSecurityScanReportData: vi.fn(() => ({})),
  toGuardReportRecord: vi.fn(() => ({})),
}));

vi.mock('../../electron/ipc/engines-scanners', () => ({
  runSecurityHandler: vi.fn(),
  runRefactorHandler: vi.fn(),
  garbageCleanHandler: vi.fn(),
  garbageRestoreHandler: vi.fn(),
  garbageDashboardPatch: vi.fn(() => ({})),
  performanceDashboardPatch: vi.fn(() => ({})),
  readDiagnosticsReport: vi.fn(),
  collectOpenCodeCandidates: vi.fn(),
  spawnOpenCodeFix: vi.fn(),
}));

vi.mock('@zh/guard', () => ({ appendGuardReport: vi.fn(), toGuardReportRecord: vi.fn() }));

vi.mock('@zh/pipeline', () => ({
  createReport: vi.fn((init: { stage?: string; passed?: boolean; error?: string }) => ({
    stage: init.stage ?? 'idle',
    passed: init.passed ?? false,
    error: init.error,
    timestamp: '2026-10-26T00:00:00.000Z',
  })),
}));

import { ipcMain } from 'electron';
import { registerEnginesIpc } from '../../electron/ipc/engines';
import { isCancelledFailure, rethrowIfCancelled } from '../../electron/pipeline-protocol';

/** Electron IPC handler 的第一个入参是 event 对象，不是业务参数 */
const EVENT = {} as unknown;

/** 主进程写进 reject 消息的取消标记（与渲染层 services/cancel-error.ts 同一字面量） */
const CANCELLED = '[cancelled] 任务已取消';

/** 假的 TaskManager：waitFor 按脚本 reject */
function fakeManager(rejectWith?: Error): {
  start: ReturnType<typeof vi.fn>;
  waitFor: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(() => ({ id: 'task-1', kind: 'pipeline', projectPath: '/p', status: 'running', progress: 0, startedAt: '2026-10-26T00:00:00.000Z' })),
    waitFor: vi.fn(() => (rejectWith ? Promise.reject(rejectWith) : Promise.resolve({}))),
    list: vi.fn(() => []),
    get: vi.fn(() => undefined),
    cancel: vi.fn(() => true),
  };
}

/** 从 ipcMain.handle 的 mock 里取出某个通道的 handler */
function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const calls = vi.mocked(ipcMain.handle).mock.calls as unknown as [string, (...a: unknown[]) => unknown][];
  const hit = calls.find(([name]) => name === channel);
  if (!hit) throw new Error(`通道 ${channel} 没注册`);
  return hit[1];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('A. 取消判据（纯函数）', () => {
  it('带标记的取消错误认得出来', () => {
    expect(isCancelledFailure(new Error(CANCELLED))).toBe(true);
    expect(isCancelledFailure(CANCELLED)).toBe(true);
  });

  it('真实故障不得被误判为取消（否则真故障会被静默吞掉）', () => {
    for (const err of [
      new Error('spawn semgrep ENOENT'),
      new Error('任务执行失败'),
      new Error('[pipeline-host] 子进程异常退出'),
      new Error(''),
    ]) {
      expect(isCancelledFailure(err), `误判: ${err.message}`).toBe(false);
    }
    expect(isCancelledFailure(null)).toBe(false);
    expect(isCancelledFailure(undefined)).toBe(false);
    expect(isCancelledFailure({ message: CANCELLED })).toBe(false);
  });

  it('rethrowIfCancelled：取消必抛、真实故障不抛', () => {
    expect(() => rethrowIfCancelled(new Error(CANCELLED))).toThrow(CANCELLED);
    expect(() => rethrowIfCancelled(new Error('boom'))).not.toThrow();
    expect(() => rethrowIfCancelled(undefined)).not.toThrow();
  });
});

describe('B. 行为级：取消必须 reject 到渲染层（不得变成失败报告）', () => {
  it('engine:runPipeline 遇到取消 → reject（而不是返回带 error 的失败报告）', async () => {
    registerEnginesIpc(fakeManager(new Error(CANCELLED)) as never);
    const handler = handlerFor('engine:runPipeline');

    await expect(handler(EVENT, '/p', { sop: true })).rejects.toThrow(CANCELLED);
  });

  it('engine:runGuard 遇到取消 → reject（而不是返回空报告谎报"很干净"）', async () => {
    registerEnginesIpc(fakeManager(new Error(CANCELLED)) as never);
    const handler = handlerFor('engine:runGuard');

    await expect(handler(EVENT, '/p', undefined)).rejects.toThrow(CANCELLED);
  });

  it('engine:runGarbageScan 遇到取消 → reject', async () => {
    registerEnginesIpc(fakeManager(new Error(CANCELLED)) as never);
    const handler = handlerFor('engine:runGarbageScan');

    await expect(handler(EVENT, '/p')).rejects.toThrow(CANCELLED);
  });

  it('engine:runPerformance 遇到取消 → reject', async () => {
    registerEnginesIpc(fakeManager(new Error(CANCELLED)) as never);
    const handler = handlerFor('engine:runPerformance');

    await expect(handler(EVENT, '/p')).rejects.toThrow(CANCELLED);
  });
});

describe('C. 误报防护：真实故障仍走降级兜底（不许一起抛出去）', () => {
  it('engine:runPipeline 遇到真实故障 → 仍返回失败报告，不 reject', async () => {
    registerEnginesIpc(fakeManager(new Error('semgrep ENOENT')) as never);
    const handler = handlerFor('engine:runPipeline');

    const result = (await handler(EVENT, '/p', { sop: true })) as { error?: string };
    expect(result.error).toContain('semgrep ENOENT');
  });

  it('engine:runGuard 遇到真实故障 → 仍返回空报告，不 reject', async () => {
    registerEnginesIpc(fakeManager(new Error('guard worker died')) as never);
    const handler = handlerFor('engine:runGuard');

    await expect(handler(EVENT, '/p', undefined)).resolves.toBeTruthy();
  });
});
