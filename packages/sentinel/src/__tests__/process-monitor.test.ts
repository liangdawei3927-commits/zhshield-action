import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProcessMonitorConfig } from '../process-monitor';

// ─── Mock 子进程类型 ─────────────────────────────────────

interface MockChildProcess extends NodeJS.EventEmitter {
  pid: number;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: string): boolean;
  stdout: NodeJS.EventEmitter;
  stderr: NodeJS.EventEmitter;
}

// ─── vi.hoisted: 变量在 vi.mock 工厂和测试代码间共享 ─────

const { spawnSpy, getProcs, resetProcs } = vi.hoisted(() => {
  const procs: MockChildProcess[] = [];
  const spy = vi.fn((_cmd: string, _args: string[], _opts: unknown): MockChildProcess => {
    const { EventEmitter } = require('node:events') as { EventEmitter: new () => NodeJS.EventEmitter };
    const proc = new EventEmitter() as MockChildProcess;
    proc.pid = 12345;
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = vi.fn((signal?: string) => {
      proc.killed = true;
      proc.exitCode = 0;
      process.nextTick(() => proc.emit('exit', 0, signal ?? null));
      return true;
    });
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    procs.push(proc);
    return proc;
  });
  return {
    spawnSpy: spy,
    getProcs: () => procs,
    resetProcs: () => { procs.length = 0; },
  };
});

vi.mock('child_process', () => ({
  spawn: spawnSpy,
}));

// ─── 导入被测模块（在 vi.mock 之后） ──────────────────

import { ProcessMonitor } from '../process-monitor';
import { EventCenter } from '../event-center';

// ─── 测试辅助 ──────────────────────────────────────────

/** 查找 EventCenter 中 history.action 为指定值的事件 */
function findEventByAction(ec: EventCenter, action: string) {
  return ec.listEvents().find(e => e.history[0]?.action === action);
}

function makeConfig(overrides?: Partial<ProcessMonitorConfig>): ProcessMonitorConfig {
  return {
    projectId: 'test-proj',
    command: 'echo',
    args: ['hello'],
    cwd: '/tmp',
    healthCheckIntervalMs: 50,
    restartDelayMs: 10,
    maxRestarts: 3,
    ...overrides,
  };
}

function latestProc(): MockChildProcess {
  const procs = getProcs();
  return procs.at(-1);
}

// ─── 测试 ──────────────────────────────────────────────

describe('ProcessMonitor — 进程监控', () => {
  let ec: EventCenter;
  let monitor: ProcessMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    resetProcs();
    vi.useFakeTimers();
    ec = new EventCenter();
    monitor = new ProcessMonitor(ec);
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  // ─── start / stop ────────────────────────────────────

  it('1. start(): 启动后 isRunning 为 true', () => {
    monitor.start(makeConfig());
    expect(monitor.isRunning()).toBe(true);
  });

  it('2. start(): 生成 process-started 事件', () => {
    monitor.start(makeConfig());

    const event = findEventByAction(ec, 'process-started');
    expect(event).toBeDefined();
    expect(event!.projectId).toBe('test-proj');
    expect(event!.title).toContain('echo');
  });

  it('3. start(): 获取进程 PID', () => {
    monitor.start(makeConfig());
    expect(monitor.getPid()).toBe(12345);
  });

  it('3b. start(): spawn 不启用 shell（shell:false，防命令注入）', () => {
    monitor.start(makeConfig());
    const opts = spawnSpy.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(opts?.shell).toBe(false);
  });

  it('4. stop(): 停止后 isRunning 为 false', () => {
    monitor.start(makeConfig());
    expect(monitor.isRunning()).toBe(true);

    monitor.stop();
    expect(monitor.isRunning()).toBe(false);
  });

  it('5. stop(): 清除健康检查定时器', () => {
    monitor.start(makeConfig());
    monitor.stop();

    vi.advanceTimersByTime(500);

    const healthFailed = ec.listEvents().filter(e => e.history[0]?.action === 'health-check-failed');
    expect(healthFailed).toHaveLength(0);
  });

  it('6. stop(): 未启动时 stop 不报错', () => {
    expect(() => monitor.stop()).not.toThrow();
  });

  // ─── 未启动状态 ──────────────────────────────────────

  it('7. 未启动时 isRunning 返回 false', () => {
    expect(monitor.isRunning()).toBe(false);
  });

  it('8. 未启动时 getPid 返回 undefined', () => {
    expect(monitor.getPid()).toBeUndefined();
  });

  // ─── 重启 ────────────────────────────────────────────

  it('9. restart(): 达到最大重启次数后触发 restart-limit-reached 事件', () => {
    const config = makeConfig({ maxRestarts: 2 });
    monitor.start(config);

    // 1st restart
    monitor.restart();
    vi.advanceTimersByTime(10);
    // 2nd restart (at limit)
    monitor.restart();
    vi.advanceTimersByTime(10);
    // 3rd restart (exceeds limit)
    monitor.restart();

    const limitEvent = findEventByAction(ec, 'restart-limit-reached');
    expect(limitEvent).toBeDefined();
    expect(limitEvent!.severity).toBe('p1');
  });

  it('10. restart(): 无 config 时不报错', () => {
    expect(() => monitor.restart()).not.toThrow();
  });

  // ─── 进程退出事件 ─────────────────────────────────────

  it('11. 进程非零退出触发 process-exited 事件 (severity p2)', () => {
    monitor.start(makeConfig());

    const proc = latestProc();
    proc.exitCode = 1;
    proc.emit('exit', 1, null);

    const exitEvent = findEventByAction(ec, 'process-exited');
    expect(exitEvent).toBeDefined();
    expect(exitEvent!.severity).toBe('p2');
  });

  it('12. 进程零退出触发 process-exited 事件 (severity p3)', () => {
    const config = makeConfig({ maxRestarts: 0 });
    monitor.start(config);

    const proc = latestProc();
    proc.exitCode = 0;
    proc.emit('exit', 0, null);

    const exitEvent = findEventByAction(ec, 'process-exited');
    expect(exitEvent).toBeDefined();
  });

  // ─── stderr 事件 ─────────────────────────────────────

  it('13. stderr 包含 error 触发 process-stderr 事件', () => {
    monitor.start(makeConfig());

    const proc = latestProc();
    proc.stderr.emit('data', Buffer.from('Error: something failed'));

    const stderrEvent = findEventByAction(ec, 'process-stderr');
    expect(stderrEvent).toBeDefined();
    expect(stderrEvent!.severity).toBe('p2');
  });

  it('14. stderr 不含 error/exception 不触发事件', () => {
    monitor.start(makeConfig());

    const proc = latestProc();
    proc.stderr.emit('data', Buffer.from('normal output'));

    const stderrEvents = ec.listEvents().filter(e => e.history[0]?.action === 'process-stderr');
    expect(stderrEvents).toHaveLength(0);
  });

  // ─── 进程错误 ────────────────────────────────────────

  it('15. 进程错误触发 process-error 事件 (severity p1)', () => {
    monitor.start(makeConfig());

    const proc = latestProc();
    proc.emit('error', new Error('ENOENT'));

    const errorEvent = findEventByAction(ec, 'process-error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.severity).toBe('p1');
    expect(errorEvent!.context).toHaveProperty('error', 'ENOENT');
  });

  // ─── 健康检查 ────────────────────────────────────────

  it('16. 进程停止后健康检查触发 health-check-failed 事件', () => {
    monitor.start(makeConfig());

    const proc = latestProc();
    proc.exitCode = 1; // process no longer running

    vi.advanceTimersByTime(60); // past healthCheckIntervalMs=50

    const healthEvent = findEventByAction(ec, 'health-check-failed');
    expect(healthEvent).toBeDefined();
  });

  // ─── 默认参数 ────────────────────────────────────────

  it('17. config.maxRestarts 默认为 3', () => {
    const config = makeConfig({ maxRestarts: undefined });
    monitor.start(config);

    // 3 restarts — should be allowed
    monitor.restart();
    vi.advanceTimersByTime(10);
    monitor.restart();
    vi.advanceTimersByTime(10);
    monitor.restart();

    // No limit event yet
    let limitEvent = findEventByAction(ec, 'restart-limit-reached');
    expect(limitEvent).toBeUndefined();

    // 4th restart should trigger limit
    vi.advanceTimersByTime(10);
    monitor.restart();

    limitEvent = findEventByAction(ec, 'restart-limit-reached');
    expect(limitEvent).toBeDefined();
  });

  it('18. config 缺少 args 时不报错', () => {
    const config = makeConfig({ args: undefined });
    expect(() => monitor.start(config)).not.toThrow();
    expect(monitor.isRunning()).toBe(true);
  });

  // ─── 多次 start 重置状态 ──────────────────────────────

  it('19. 多次 start 重置重启计数', () => {
    const config = makeConfig({ maxRestarts: 1 });
    monitor.start(config);
    monitor.restart();
    vi.advanceTimersByTime(10);

    // start again — restarts should reset
    monitor.start(config);

    // 3 spawn calls: initial start + restart after first start + second start
    expect(spawnSpy).toHaveBeenCalledTimes(3);
  });
});
