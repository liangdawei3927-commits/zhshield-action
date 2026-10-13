import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProcessMonitorConfig } from '../process-monitor';
import {
  classifyNonRemediableFault,
  decideRestart,
  FaultDetector,
  isInformationalEvent,
} from '../process-monitor';

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
    const { EventEmitter } = require('node:events') as {
      EventEmitter: new () => NodeJS.EventEmitter;
    };
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
    resetProcs: () => {
      procs.length = 0;
    },
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
  return ec.listEvents().find((e) => e.history[0]?.action === action);
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

  it('3c. start(): 命令串含空格（如 "npm run dev"）时拆分为可执行名+参数，shell 保持 false', () => {
    monitor.start(makeConfig({ command: 'echo hello', args: undefined }));

    const [cmd, args, opts] = spawnSpy.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('echo');
    expect(args).toEqual(['hello']);
    expect(opts.shell).toBe(false);
    expect(monitor.isRunning()).toBe(true);
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

    const healthFailed = ec
      .listEvents()
      .filter((e) => e.history[0]?.action === 'health-check-failed');
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

  it('9. restart(): 达到最大重启次数后触发 restart-limit-reached 事件 (severity p2)', () => {
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
    expect(limitEvent!.severity).toBe('p2');
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

    const stderrEvents = ec.listEvents().filter((e) => e.history[0]?.action === 'process-stderr');
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

  // ─── 信息事件分类 & 稳定去重 ─────────────────────────────

  it('20. isInformationalEvent: p3 生命周期事件为 true，p2 故障事件为 false', () => {
    monitor.start(makeConfig());

    const started = findEventByAction(ec, 'process-started');
    expect(started).toBeDefined();
    expect(isInformationalEvent(started!)).toBe(true);

    const proc = latestProc();
    proc.stderr.emit('data', Buffer.from('Error: boom'));
    const stderrEvent = findEventByAction(ec, 'process-stderr');
    expect(stderrEvent).toBeDefined();
    expect(isInformationalEvent(stderrEvent!)).toBe(false);
  });

  it('21. 稳定去重键：同命令重复 start 在去重窗口内合并为一次启动事件', () => {
    monitor.start(makeConfig());
    monitor.start(makeConfig());

    const startedEvents = ec.listEvents().filter((e) => e.history[0]?.action === 'process-started');
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].occurrenceCount).toBe(2);
  });

  // ─── 真实健康探测（healthCommand） ─────────────────────────

  it('22. healthCommand 探测成功 (exit 0) 不触发健康失败', () => {
    monitor.start(makeConfig({ healthCommand: 'curl', healthArgs: ['-f', 'http://x'] }));

    vi.advanceTimersByTime(60);
    expect(spawnSpy).toHaveBeenCalledTimes(2); // main process + probe

    const probe = latestProc();
    probe.exitCode = 0;
    probe.emit('exit', 0, null);

    const healthFailed = ec
      .listEvents()
      .filter((e) => e.history[0]?.action === 'health-check-failed');
    expect(healthFailed).toHaveLength(0);
  });

  it('23. healthCommand 探测失败 (exit 1) 触发 health-check-failed (p1)', () => {
    monitor.start(makeConfig({ healthCommand: 'curl', healthArgs: ['-f', 'http://x'] }));

    vi.advanceTimersByTime(60);

    const probe = latestProc();
    probe.exitCode = 1;
    probe.emit('exit', 1, null);

    const healthEvent = findEventByAction(ec, 'health-check-failed');
    expect(healthEvent).toBeDefined();
    expect(healthEvent!.severity).toBe('p1');
  });

  it('24. 未配置 healthCommand 时不执行探测（行为向后兼容）', () => {
    monitor.start(makeConfig());
    vi.advanceTimersByTime(60);
    expect(spawnSpy).toHaveBeenCalledTimes(1); // 仅主进程，无探测
  });

  // ─── 重启预算结算幂等 ─────────────────────────────────

  it('25. 连续非零退出：每次失败只消耗一次预算（健康探测的并发请求不重复结算）', () => {
    // healthCheckIntervalMs 远小于 restartDelayMs：健康定时器必然在"重启在途"窗口内反复触发
    const config = makeConfig({ maxRestarts: 3, healthCheckIntervalMs: 20, restartDelayMs: 100 });
    monitor.start(config);
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    for (let failure = 0; failure < 3; failure++) {
      const proc = latestProc();
      proc.exitCode = 1;
      proc.emit('exit', 1, null);
      vi.advanceTimersByTime(100); // 跨过 restartDelayMs，期间健康定时器触发 5 次
    }

    // 3 次失败应恰好用满 3 次预算；若被重复结算，此时早已 exhausted
    expect(monitor.getState()).toBe('running');
    expect(findEventByAction(ec, 'restart-limit-reached')).toBeUndefined();
    expect(spawnSpy).toHaveBeenCalledTimes(4); // 首次拉起 + 3 次重拉

    const proc = latestProc();
    proc.exitCode = 1;
    proc.emit('exit', 1, null);

    expect(monitor.getState()).toBe('exhausted');
  });

  // ─── 端口占用：不消耗预算，转 suppressed ──────────────────

  it('26. 端口占用退出：不重拉、不消耗预算，转 suppressed 并发出可操作 p2', () => {
    monitor.start(makeConfig({ maxRestarts: 3 }));

    const proc = latestProc();
    proc.stderr.emit('data', Buffer.from('Error: Port 5173 is already in use'));
    proc.exitCode = 1;
    proc.emit('exit', 1, null);

    const suppressed = findEventByAction(ec, 'port-in-use-suppressed');
    expect(suppressed).toBeDefined();
    expect(suppressed!.severity).toBe('p2');
    expect(suppressed!.context.port).toBe(5173);
    expect(suppressed!.history[0]?.detail).toContain('5173');
    expect(monitor.getState()).toBe('suppressed');
    expect(spawnSpy).toHaveBeenCalledTimes(1); // 未重拉
    expect(findEventByAction(ec, 'restart-limit-reached')).toBeUndefined();
  });

  it('27. 端口占用 p2 与通用 stderr p2 去重键不同（否则互相吞掉）', () => {
    monitor.start(makeConfig());

    const proc = latestProc();
    proc.stderr.emit('data', Buffer.from('Error: Port 5173 is already in use'));
    proc.exitCode = 1;
    proc.emit('exit', 1, null);

    const stderrEvent = findEventByAction(ec, 'process-stderr');
    const suppressedEvent = findEventByAction(ec, 'port-in-use-suppressed');
    expect(stderrEvent).toBeDefined();
    expect(suppressedEvent).toBeDefined();
    expect(stderrEvent!.dedupeKey).not.toBe(suppressedEvent!.dedupeKey);
  });

  it('28. 端口占用错误分块到达也能识别（跨块累积后单次分类）', () => {
    monitor.start(makeConfig());

    const proc = latestProc();
    proc.stderr.emit('data', Buffer.from('Error: Port 51'));
    proc.stderr.emit('data', Buffer.from('73 is already'));
    proc.stderr.emit('data', Buffer.from(' in use'));
    proc.exitCode = 1;
    proc.emit('exit', 1, null);

    expect(monitor.getState()).toBe('suppressed');
    expect(findEventByAction(ec, 'port-in-use-suppressed')!.history[0]?.detail).toContain('5173');
  });

  it('29. 上一轮拉起的端口占用输出不污染下一轮判定', () => {
    monitor.start(makeConfig());
    const first = latestProc();
    first.stderr.emit('data', Buffer.from('Error: Port 5173 is already in use'));
    first.emit('exit', 1, null);
    expect(monitor.getState()).toBe('suppressed');

    // 用户显式重新启动（重新武装）
    monitor.start(makeConfig());
    const second = latestProc();
    second.exitCode = 1;
    second.emit('exit', 1, null);

    expect(monitor.getState()).toBe('running'); // 本轮无端口占用输出 → 正常走重启预算
  });

  it('30. EADDRINUSE 形态同样抑制重启（Node 错误码）', () => {
    monitor.start(makeConfig());

    const proc = latestProc();
    proc.stderr.emit('data', Buffer.from('Error: listen EADDRINUSE: address already in use'));
    proc.exitCode = 1;
    proc.emit('exit', 1, null);

    expect(monitor.getState()).toBe('suppressed');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  // ─── 生命周期终态可观测 ─────────────────────────────────

  it('31. getState(): 区分从未启动 / 运行中 / 预算耗尽，start() 可重新武装', () => {
    expect(monitor.getState()).toBe('stopped');

    monitor.start(makeConfig({ maxRestarts: 0 }));
    expect(monitor.getState()).toBe('running');

    const proc = latestProc();
    proc.exitCode = 1;
    proc.emit('exit', 1, null);
    expect(monitor.getState()).toBe('exhausted');

    monitor.start(makeConfig());
    expect(monitor.getState()).toBe('running');
  });

  it('32. 端口占用签名位于长输出尾部时仍识别（bounded 窗口必须保留尾部）', () => {
    monitor.start(makeConfig({ maxRestarts: 3 }));

    const proc = latestProc();
    // 复刻 npm/turbo 包装命令：先刷远超窗口上限的构建日志，致命错误最后到达
    proc.stderr.emit('data', Buffer.from('x'.repeat(20000)));
    proc.stderr.emit('data', Buffer.from('Error: Port 5173 is already in use'));
    proc.exitCode = 1;
    proc.emit('exit', 1, null);

    expect(monitor.getState()).toBe('suppressed');
    expect(findEventByAction(ec, 'port-in-use-suppressed')!.context.port).toBe(5173);
    expect(findEventByAction(ec, 'restart-limit-reached')).toBeUndefined();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  // ─── 进程组生命周期 & 诊断可观测 ───────────────────────────

  it('33. spawn 以独立进程组启动（POSIX detach，便于退出/重启时整树回收）', () => {
    monitor.start(makeConfig());

    const opts = spawnSpy.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(opts?.detached).toBe(process.platform !== 'win32');
  });

  it('34. restart-limit-reached 事件携带输出尾部供现场诊断', () => {
    monitor.start(makeConfig({ maxRestarts: 0 }));

    const proc = latestProc();
    proc.stderr.emit('data', Buffer.from('boom: something exploded at startup'));
    proc.exitCode = 1;
    proc.emit('exit', 1, null);

    const limitEvent = findEventByAction(ec, 'restart-limit-reached');
    expect(limitEvent).toBeDefined();
    expect(String(limitEvent!.context.outputTail)).toContain('something exploded');
    expect(limitEvent!.history[0]?.detail).toContain('something exploded');
  });

  it('35. 健康探测挂死：越过硬超时判定失败并回收探测进程（不再叠加探测）', () => {
    monitor.start(
      makeConfig({
        healthCommand: 'curl',
        healthArgs: ['-f', 'http://slow'],
        healthCheckIntervalMs: 10000,
        restartDelayMs: 100000,
      }),
    );

    vi.advanceTimersByTime(10000); // 触发一次探测；此后探测进程始终不退出
    const probe = latestProc();
    expect(probe.killed).toBe(false);

    vi.advanceTimersByTime(5000); // 越过探测硬超时

    expect(findEventByAction(ec, 'health-check-failed')).toBeDefined();
    expect(probe.killed).toBe(true);
  });
});

// ─── 纯函数单测（无定时器） ───────────────────────────────

describe('classifyNonRemediableFault — 端口占用事实提取', () => {
  it('A1. Node 错误码 EADDRINUSE 识别为端口占用并取出端口号', () => {
    const result = classifyNonRemediableFault(
      'Error: listen EADDRINUSE: address already in use 127.0.0.1:5173',
    );
    expect(result).toEqual({ kind: 'port-in-use', port: 5173 });
  });

  it('A2. Vite 可读形态 "Port 5173 is already in use" 识别并取出 5173', () => {
    expect(classifyNonRemediableFault('Error: Port 5173 is already in use')).toEqual({
      kind: 'port-in-use',
      port: 5173,
    });
  });

  it('A3. 大小写不敏感匹配', () => {
    expect(classifyNonRemediableFault('error: PORT 5173 IS ALREADY IN USE')).toEqual({
      kind: 'port-in-use',
      port: 5173,
    });
  });

  it('A4. 消息分块到达时按累积后的完整串判定', () => {
    const chunks = ['Error: Port 51', '73 is already', ' in use'];
    expect(classifyNonRemediableFault(chunks.join(''))).toEqual({
      kind: 'port-in-use',
      port: 5173,
    });
  });

  it('A5. 端口号缺失时返回 port: null（不猜测、不报错）', () => {
    expect(classifyNonRemediableFault('Error: listen EADDRINUSE: address already in use')).toEqual({
      kind: 'port-in-use',
      port: null,
    });
    expect(classifyNonRemediableFault('Error: Port is already in use')).toEqual({
      kind: 'port-in-use',
      port: null,
    });
  });

  it('A6. 普通崩溃输出归类为 none', () => {
    expect(classifyNonRemediableFault('Error: TypeError: undefined is not a function')).toEqual({
      kind: 'none',
    });
    expect(classifyNonRemediableFault('')).toEqual({ kind: 'none' });
  });
});

describe('decideRestart — 重启预算结算', () => {
  it('B1. 已用次数低于上限时返回 restart', () => {
    expect(decideRestart(0, 3, false)).toEqual({ kind: 'restart' });
    expect(decideRestart(2, 3, false)).toEqual({ kind: 'restart' });
  });

  it('B2. 已用次数达到上限时返回 exhausted（边界取等号）', () => {
    expect(decideRestart(3, 3, false)).toEqual({ kind: 'exhausted' });
    expect(decideRestart(4, 3, false)).toEqual({ kind: 'exhausted' });
  });

  it('B3. 已有重启在途时返回 suppress，不消耗第二次预算', () => {
    expect(decideRestart(1, 3, true)).toEqual({ kind: 'suppress' });
    // 即使已达上限，在途标志仍优先：这一次失败已被结算过
    expect(decideRestart(3, 3, true)).toEqual({ kind: 'suppress' });
  });
});

describe('FaultDetector — 增量故障检测', () => {
  it('C1. 命中后锁定：后续超长横幅无法把已确认的故障挤出窗口', () => {
    const detector = new FaultDetector();
    detector.feed('Error: Port 5173 is already in use');
    detector.feed('x'.repeat(50000));

    expect(detector.fault()).toEqual({ kind: 'port-in-use', port: 5173 });
  });

  it('C2. 跨块签名仍可识别（窗口累积）', () => {
    const detector = new FaultDetector();
    ['Error: Port 51', '73 is already', ' in use'].forEach((chunk) => detector.feed(chunk));

    expect(detector.fault()).toEqual({ kind: 'port-in-use', port: 5173 });
  });

  it('C3. reset() 清空窗口与锁定结论（供每轮重新武装）', () => {
    const detector = new FaultDetector();
    detector.feed('EADDRINUSE');
    expect(detector.fault().kind).toBe('port-in-use');

    detector.reset();
    detector.feed('normal startup output');

    expect(detector.fault()).toEqual({ kind: 'none' });
  });
});
