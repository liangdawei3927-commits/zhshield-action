/**
 * 进程监控器：子进程生命周期状态机（启动 / 输出 / 退出 / 健康探测 / 重启预算）。
 *
 * 结构约定（本文件只保留"状态"）：
 * - 纯判定（故障分类、重启结算、通知类事件判定）→ `process-faults.ts`
 * - 事件规格塑形、事件上报、子进程启动 → `process-events.ts`
 *
 * 对外接口不变：下列名字仍可从本模块导入（历史调用点与单测依赖这一点）。
 */

import type { ChildProcess } from 'child_process';
import type { EventCenter } from './event-center';
import { reportHealthCheckFailure, runHealthProbe } from './health-probe';
import { terminateProcessTree } from './process-tree';
import type { EventSeverity } from './types';
import { FaultDetector, decideRestart } from './process-faults';
import type { ProcessMonitorState, RestartDecision } from './process-faults';
import {
  emitProcessEvent,
  exitedSpec,
  launchFailedSpec,
  portInUseSpec,
  processErrorSpec,
  restartLimitSpec,
  spawnProcess,
  startedSpec,
  stderrSpec,
  type ProcessEventSpec,
} from './process-events';

export { FaultDetector, classifyNonRemediableFault, decideRestart, isInformationalEvent } from './process-faults';
export type { NonRemediableFault, ProcessMonitorState, RestartDecision } from './process-faults';

/** 本轮输出尾部保留上限：仅供 restart-limit 事件的诊断上下文，故障判定不依赖它 */
const LAUNCH_OUTPUT_MAX_CHARS = 8192;

/** 进程监控器配置：启动命令、健康探测间隔与命令、重启延迟与次数上限 */
export interface ProcessMonitorConfig {
  projectId: string;
  command: string;
  args?: string[];
  cwd: string;
  healthCheckIntervalMs?: number;
  restartDelayMs?: number;
  maxRestarts?: number;
  healthCommand?: string;
  healthArgs?: string[];
}

/** 保留本轮输出尾部，作为 restart-limit 事件的诊断上下文（截头不截尾） */
function appendBoundedOutput(current: string, chunk: string): string {
  return (current + chunk).slice(-LAUNCH_OUTPUT_MAX_CHARS);
}

/** 进程命令级失败的两个来源：子进程 error 事件 / spawn 阶段异常 */
type CommandFailureKind = 'error' | 'launch-failed';

export class ProcessMonitor {
  private eventCenter: EventCenter;
  private proc: ChildProcess | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private readonly restartBudget: { used: number; inFlight: boolean } = {
    used: 0,
    inFlight: false,
  };
  private config: ProcessMonitorConfig | null = null;
  private running: boolean = false;
  /** 每次拉起进程时递增；用于阻断陈旧健康探测回调查出新一轮后的重复重启 */
  private probeEpoch: number = 0;
  /** 已有一次健康探测在途；避免探测命令挂死时定时器每轮再叠加一个探测进程 */
  private probeInFlight: boolean = false;
  /** 本轮输出尾部（stdout + stderr），每次 launchProcess 清空；仅供事件诊断上下文 */
  private launchOutput: string = '';
  /** 本轮不可修复故障的增量检测器（对输出截断免疫） */
  private faultDetector: FaultDetector = new FaultDetector();
  /** 终止原因；null 表示非终态，用于把"已终止"与"从未启动"区分开 */
  private terminalState: 'suppressed' | 'exhausted' | null = null;

  constructor(eventCenter: EventCenter) {
    this.eventCenter = eventCenter;
  }

  start(config: ProcessMonitorConfig): void {
    this.config = config;
    this.running = true;
    this.restartBudget.used = 0;
    this.terminalState = null;
    this.launchProcess();
  }

  stop(): void {
    this.running = false;
    this.terminalState = null;
    this.probeInFlight = false;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    terminateProcessTree(this.proc);
    this.proc = null;
  }

  /** 生命周期状态：预算耗尽 / 不可修复故障后永久静默时可被观测到；重新武装只能由用户显式 start() 发起 */
  getState(): ProcessMonitorState {
    if (this.terminalState !== null) return this.terminalState;
    return this.running ? 'running' : 'stopped';
  }

  /** 请求一次重启；返回 {@link decideRestart} 的结论，便于观察本次请求是否真的消耗了预算。
   *  未 start 过（无 config）时返回 suppress：既不消耗预算也不重拉。 */
  restart(): RestartDecision {
    const config = this.config;
    if (!config) return { kind: 'suppress' };
    const maxRestarts = config.maxRestarts ?? 3;
    const decision = decideRestart(
      this.restartBudget.used,
      maxRestarts,
      this.restartBudget.inFlight,
    );

    if (decision.kind === 'exhausted') {
      this.emitRestartLimitReached(config.command, maxRestarts);
      this.terminalState = 'exhausted';
      this.halt();
      return decision;
    }
    if (decision.kind === 'suppress') return decision;

    terminateProcessTree(this.proc);
    this.proc = null;
    this.restartBudget.used++;
    this.restartBudget.inFlight = true;
    const delay = config.restartDelayMs ?? 2000;
    setTimeout(() => {
      if (this.running) this.launchProcess();
    }, delay);
    return decision;
  }

  isRunning(): boolean {
    if (!this.proc) return false;
    try {
      return this.proc.exitCode === null;
    } catch {
      return false;
    }
  }

  getPid(): number | undefined {
    return this.proc?.pid;
  }

  private launchProcess(): void {
    if (!this.config) return;
    const cmd = this.config.command;
    const args = this.config.args || [];
    const cwd = this.config.cwd;
    this.probeEpoch++;
    this.launchOutput = '';
    this.faultDetector.reset();
    this.restartBudget.inFlight = false;
    try {
      this.proc = spawnProcess(cmd, args, cwd);
      this.attachProcessHandlers(cmd, this.proc.pid);
      this.startHealthCheck();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitCommandFailure(cmd, message, 'launch-failed');
    }
  }

  /** 挂接子进程输出/退出/错误回调并上报启动事件 */
  private attachProcessHandlers(cmd: string, pid: number | undefined): void {
    const config = this.config;
    if (!this.proc || !config) return;

    this.emitProcessStarted(cmd, pid, config.cwd, config.args || []);

    this.proc.stdout?.on('data', (data: Buffer) => {
      // stdout is piped for potential log collection integration
      const text = data.toString();
      this.launchOutput = appendBoundedOutput(this.launchOutput, text);
      this.faultDetector.feed(text);
    });
    this.proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.launchOutput = appendBoundedOutput(this.launchOutput, text);
      this.faultDetector.feed(text);
      this.emitProcessStderr(cmd, pid, data);
    });
    this.proc.on('exit', (code, signal) => this.handleProcessExit(cmd, code, signal));
    this.proc.on('error', (err) => this.emitCommandFailure(cmd, err.message, 'error'));
  }

  private emit(spec: ProcessEventSpec): void {
    const config = this.config;
    if (!config) return;
    emitProcessEvent(this.eventCenter, config.projectId, spec);
  }

  private emitProcessStarted(
    cmd: string,
    pid: number | undefined,
    cwd: string,
    args: string[],
  ): void {
    this.emit(startedSpec(cmd, pid, cwd, args));
  }

  private emitProcessStderr(cmd: string, pid: number | undefined, data: Buffer): void {
    const text = data.toString();
    // stderr output often indicates issues
    if (text.toLowerCase().includes('error') || text.toLowerCase().includes('exception')) {
      this.emit(stderrSpec(cmd, pid, text));
    }
  }

  private handleProcessExit(cmd: string, code: number | null, signal: NodeJS.Signals | null): void {
    const config = this.config;
    if (!config) return;
    const pid2 = this.proc?.pid;
    this.proc = null;
    const severity: EventSeverity = code === 0 ? 'p3' : 'p2';
    this.emit(exitedSpec({ cmd, code, signal, pid: pid2, severity }));

    if (!this.running || code === 0) return;
    const fault = this.faultDetector.fault();
    if (fault.kind === 'port-in-use') return this.suppressForPortConflict(cmd, fault.port);
    this.restart();
  }

  /** 端口被占：占用者多半是用户自己那个健康的 dev server（strictPort 下 Vite 不退让端口），
   *  重启只会烧光重启预算并最终报出假 p1，故不消耗预算、不重拉，改发可操作 p2。 */
  private suppressForPortConflict(cmd: string, port: number | null): void {
    this.emit(portInUseSpec(cmd, port));
    this.terminalState = 'suppressed';
    this.halt();
  }

  /** 停止监控：预算耗尽 / 不可修复故障后继续轮询只会每轮刷事件 */
  private halt(): void {
    this.running = false;
    if (!this.healthTimer) return;
    clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** 重启预算耗尽属"我方重试策略"的事实（无东西丢失 / 损坏 / 暴露），不构成用户系统的危急故障 */
  private emitRestartLimitReached(command: string, maxRestarts: number): void {
    this.emit(restartLimitSpec(command, this.restartBudget.used, maxRestarts, this.launchOutput));
  }

  /** 进程命令级失败（error 事件 / 启动异常）：两者同属 p1，仅措辞不同，故共用一个出口 */
  private emitCommandFailure(cmd: string, message: string, kind: CommandFailureKind): void {
    this.emit(kind === 'error' ? processErrorSpec(cmd, message) : launchFailedSpec(cmd, message));
  }

  private startHealthCheck(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);

    const interval = this.config?.healthCheckIntervalMs ?? 10000;
    this.healthTimer = setInterval(() => {
      if (!this.running) return;

      if (!this.isRunning()) {
        this.reportHealthCheckFailure();
        if (this.running) this.restart();
        return;
      }

      this.probeIfConfigured();
    }, interval);
  }

  private reportHealthCheckFailure(probeOutput?: string): void {
    const config = this.config;
    if (!config) return;
    reportHealthCheckFailure(this.eventCenter, config.projectId, config.command, probeOutput);
  }

  private probeIfConfigured(): void {
    const config = this.config;
    if (!config?.healthCommand || this.probeInFlight) return;
    this.probeInFlight = true;
    const epoch = this.probeEpoch;
    runHealthProbe(
      { command: config.healthCommand, args: config.healthArgs, cwd: config.cwd },
      {
        isEpochCurrent: () => this.running && epoch === this.probeEpoch,
        onFailure: (output) => {
          if (!this.running) return;
          this.reportHealthCheckFailure(output);
          if (this.running) this.restart();
        },
        onSettled: () => {
          this.probeInFlight = false;
        },
      },
    );
  }
}
