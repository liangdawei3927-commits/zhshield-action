import { spawn, type ChildProcess } from 'child_process';
import { EventCenter } from './event-center';
import { reportHealthCheckFailure, runHealthProbe } from './health-probe';
import { eventKey } from './event-key';
import type { SentinelEvent } from './types';

/** 命令串按空白切分（spawnProcess 每次启动复用，避免热路径重建正则） */
const RE_WHITESPACE = /\s+/;

/**
 * p3 生命周期事件（进程启动 / 正常退出）属于"事件"而非"待处理问题"。
 * 可执行告警/派单通道应据此过滤，避免每次进程启动都派发出噪声任务。
 */
export function isInformationalEvent(
  event: Pick<SentinelEvent, 'severity' | 'history'>,
): boolean {
  if (event.severity !== 'p3') return false;
  const action = event.history[0]?.action;
  return action === 'process-started' || action === 'process-exited';
}

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

export class ProcessMonitor {
  private eventCenter: EventCenter;
  private proc: ChildProcess | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private restarts = 0;
  private config: ProcessMonitorConfig | null = null;
  private running = false;
  /** 每次拉起进程时递增；用于阻断陈旧健康探测回调查出新一轮后的重复重启 */
  private probeEpoch = 0;

  constructor(eventCenter: EventCenter) {
    this.eventCenter = eventCenter;
  }

  start(config: ProcessMonitorConfig): void {
    this.config = config;
    this.running = true;
    this.restarts = 0;
    this.launchProcess();
  }

  stop(): void {
    this.running = false;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }

  restart(): void {
    if (!this.config) return;
    const maxRestarts = this.config.maxRestarts ?? 3;
    if (this.restarts >= maxRestarts) {
      this.emitRestartLimitReached(maxRestarts);
      // 已达最大重启次数：进程反复失败，继续健康检查只会每轮刷 p1 事件。
      // 停止监控（停掉健康检查定时器 + 标记非运行），避免事件风暴。
      this.running = false;
      if (this.healthTimer) {
        clearInterval(this.healthTimer);
        this.healthTimer = null;
      }
      return;
    }

    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }

    this.restarts++;
    const delay = this.config?.restartDelayMs ?? 2000;
    setTimeout(() => {
      if (this.running) this.launchProcess();
    }, delay);
  }

  private emitRestartLimitReached(maxRestarts: number): void {
    const config = this.config;
    if (!config) return;
    const title = 'Process restart limit reached';
    this.eventCenter.createEvent({
      projectId: config.projectId,
      title,
      service: 'sentinel',
      module: 'process-monitor',
      severity: 'p1',
      context: { command: config.command, restarts: this.restarts },
      operator: 'process-monitor',
      action: 'restart-limit-reached',
      detail: `Process ${config.command} exceeded max ${maxRestarts} restarts`,
      dedupeKey: eventKey(config.projectId, 'process-monitor', title, 'p1'),
    });
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
    try {
      this.proc = this.spawnProcess(cmd, args, cwd);
      this.attachProcessHandlers(cmd, this.proc.pid);
      this.startHealthCheck();
    } catch (err: unknown) {
      this.emitProcessLaunchFailed(cmd, err);
    }
  }

  /** 以管道 stdio 启动子进程（不继承终端） */
  private spawnProcess(cmd: string, args: string[], cwd: string): ChildProcess {
    // detectRunCommand 等调用方可能传入 "npm run dev" 式命令串；shell:false 下
    // spawn 会把整串当可执行文件路径导致 ENOENT，需拆分为可执行名 + 参数。
    const tokens = cmd.trim().split(RE_WHITESPACE);
    const executable = tokens[0];
    const resolvedArgs = args.length > 0 ? args : tokens.slice(1);
    return spawn(executable, resolvedArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  }

  /** 挂接子进程输出/退出/错误回调并上报启动事件 */
  private attachProcessHandlers(cmd: string, pid: number | undefined): void {
    const config = this.config;
    if (!this.proc || !config) return;

    this.emitProcessStarted(cmd, pid, config.cwd, config.args || []);

    this.proc.stdout?.on('data', () => {
      // stdout is piped for potential log collection integration
    });

    this.proc.stderr?.on('data', (data: Buffer) => this.emitProcessStderr(cmd, pid, data));
    this.proc.on('exit', (code, signal) => this.handleProcessExit(cmd, code, signal));
    this.proc.on('error', (err) => this.emitProcessError(cmd, err));
  }

  private emitProcessStarted(
    cmd: string,
    pid: number | undefined,
    cwd: string,
    args: string[],
  ): void {
    const config = this.config;
    if (!config) return;
    const title = `Process started: ${cmd}`;
    this.eventCenter.createEvent({
      projectId: config.projectId,
      title,
      service: 'sentinel',
      module: 'process-monitor',
      severity: 'p3',
      context: { command: cmd, pid, cwd, args },
      operator: 'process-monitor',
      action: 'process-started',
      detail: `Process ${cmd} started with PID ${pid} in ${cwd}`,
      dedupeKey: eventKey(config.projectId, 'process-monitor', title, 'p3'),
    });
  }

  private emitProcessStderr(cmd: string, pid: number | undefined, data: Buffer): void {
    const config = this.config;
    if (!config) return;
    const text = data.toString();
    // stderr output often indicates issues
    if (text.toLowerCase().includes('error') || text.toLowerCase().includes('exception')) {
      const title = `Process stderr: ${cmd}`;
      this.eventCenter.createEvent({
        projectId: config.projectId,
        title,
        service: 'sentinel',
        module: 'process-monitor',
        severity: 'p2',
        context: { command: cmd, pid, stderr: text.slice(0, 500) },
        operator: 'process-monitor',
        action: 'process-stderr',
        detail: text.slice(0, 200),
        dedupeKey: eventKey(config.projectId, 'process-monitor', title, 'p2'),
      });
    }
  }

  private handleProcessExit(cmd: string, code: number | null, signal: NodeJS.Signals | null): void {
    const config = this.config;
    if (!config) return;
    const pid2 = this.proc?.pid;
    this.proc = null;
    const title = `Process exited: ${cmd} (code=${code}, signal=${signal})`;
    const severity = code === 0 ? 'p3' : 'p2';
    this.eventCenter.createEvent({
      projectId: config.projectId,
      title,
      service: 'sentinel',
      module: 'process-monitor',
      severity,
      context: { command: cmd, exitCode: code, signal, pid: pid2 },
      operator: 'process-monitor',
      action: 'process-exited',
      detail: `Process ${cmd} exited with code ${code}, signal ${signal}`,
      dedupeKey: eventKey(config.projectId, 'process-monitor', title, severity),
    });

    if (this.running && code !== 0) {
      this.restart();
    }
  }

  private emitProcessError(cmd: string, err: Error): void {
    const config = this.config;
    if (!config) return;
    const title = `Process error: ${cmd}`;
    this.eventCenter.createEvent({
      projectId: config.projectId,
      title,
      service: 'sentinel',
      module: 'process-monitor',
      severity: 'p1',
      context: { command: cmd, error: err.message },
      operator: 'process-monitor',
      action: 'process-error',
      detail: `Process ${cmd} error: ${err.message}`,
      dedupeKey: eventKey(config.projectId, 'process-monitor', title, 'p1'),
    });
  }

  private emitProcessLaunchFailed(cmd: string, err: unknown): void {
    const config = this.config;
    if (!config) return;
    const message = err instanceof Error ? err.message : String(err);
    const title = `Failed to start process: ${cmd}`;
    this.eventCenter.createEvent({
      projectId: config.projectId,
      title,
      service: 'sentinel',
      module: 'process-monitor',
      severity: 'p1',
      context: { command: cmd, error: message },
      operator: 'process-monitor',
      action: 'process-launch-failed',
      detail: `Failed to launch ${cmd}: ${message}`,
      dedupeKey: eventKey(config.projectId, 'process-monitor', title, 'p1'),
    });
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
    if (!config?.healthCommand) return;
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
      },
    );
  }
}
