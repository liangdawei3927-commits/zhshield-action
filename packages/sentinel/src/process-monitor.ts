import { spawn, type ChildProcess } from 'child_process';
import { EventCenter } from './event-center';

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
    this.eventCenter.createEvent({
      projectId: this.config!.projectId,
      title: 'Process restart limit reached',
      service: 'sentinel',
      module: 'process-monitor',
      severity: 'p1',
      context: { command: this.config!.command, restarts: this.restarts },
      operator: 'process-monitor',
      action: 'restart-limit-reached',
      detail: `Process ${this.config!.command} exceeded max ${maxRestarts} restarts`,
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

    try {
      this.proc = spawn(cmd, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      });

      this.attachProcessHandlers(cmd, this.proc.pid);
      this.startHealthCheck();
    } catch (err: unknown) {
      this.emitProcessLaunchFailed(cmd, err);
    }
  }

  /** 挂接子进程输出/退出/错误回调并上报启动事件 */
  private attachProcessHandlers(cmd: string, pid: number | undefined): void {
    if (!this.proc) return;

    this.emitProcessStarted(cmd, pid, this.config!.cwd, this.config!.args || []);

    this.proc.stdout?.on('data', () => {
      // stdout is piped for potential log collection integration
    });

    this.proc.stderr?.on('data', (data: Buffer) => this.emitProcessStderr(cmd, pid, data));
    this.proc.on('exit', (code, signal) => this.handleProcessExit(cmd, code, signal));
    this.proc.on('error', (err) => this.emitProcessError(cmd, err));
  }

  private emitProcessStarted(cmd: string, pid: number | undefined, cwd: string, args: string[]): void {
    this.eventCenter.createEvent({
      projectId: this.config!.projectId,
      title: `Process started: ${cmd}`,
      service: 'sentinel',
      module: 'process-monitor',
      severity: 'p3',
      context: { command: cmd, pid, cwd, args },
      operator: 'process-monitor',
      action: 'process-started',
      detail: `Process ${cmd} started with PID ${pid} in ${cwd}`,
    });
  }

  private emitProcessStderr(cmd: string, pid: number | undefined, data: Buffer): void {
    const text = data.toString();
    // stderr output often indicates issues
    if (text.toLowerCase().includes('error') || text.toLowerCase().includes('exception')) {
      this.eventCenter.createEvent({
        projectId: this.config!.projectId,
        title: `Process stderr: ${cmd}`,
        service: 'sentinel',
        module: 'process-monitor',
        severity: 'p2',
        context: { command: cmd, pid, stderr: text.slice(0, 500) },
        operator: 'process-monitor',
        action: 'process-stderr',
        detail: text.slice(0, 200),
      });
    }
  }

  private handleProcessExit(cmd: string, code: number | null, signal: NodeJS.Signals | null): void {
    const pid2 = this.proc?.pid;
    this.proc = null;
    this.eventCenter.createEvent({
      projectId: this.config!.projectId,
      title: `Process exited: ${cmd} (code=${code}, signal=${signal})`,
      service: 'sentinel',
      module: 'process-monitor',
      severity: code === 0 ? 'p3' : 'p2',
      context: { command: cmd, exitCode: code, signal, pid: pid2 },
      operator: 'process-monitor',
      action: 'process-exited',
      detail: `Process ${cmd} exited with code ${code}, signal ${signal}`,
    });

    if (this.running && code !== 0) {
      this.restart();
    }
  }

  private emitProcessError(cmd: string, err: Error): void {
    this.eventCenter.createEvent({
      projectId: this.config!.projectId,
      title: `Process error: ${cmd}`,
      service: 'sentinel',
      module: 'process-monitor',
      severity: 'p1',
      context: { command: cmd, error: err.message },
      operator: 'process-monitor',
      action: 'process-error',
      detail: `Process ${cmd} error: ${err.message}`,
    });
  }

  private emitProcessLaunchFailed(cmd: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.eventCenter.createEvent({
      projectId: this.config!.projectId,
      title: `Failed to start process: ${cmd}`,
      service: 'sentinel',
      module: 'process-monitor',
      severity: 'p1',
      context: { command: cmd, error: message },
      operator: 'process-monitor',
      action: 'process-launch-failed',
      detail: `Failed to launch ${cmd}: ${message}`,
    });
  }

  private startHealthCheck(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);

    const interval = this.config?.healthCheckIntervalMs ?? 10000;
    this.healthTimer = setInterval(() => {
      if (!this.running) return;

      if (!this.isRunning()) {
        this.emitHealthCheckFailure();
        if (this.running) this.restart();
      }
    }, interval);
  }

  private emitHealthCheckFailure(): void {
    this.eventCenter.createEvent({
      projectId: this.config!.projectId,
      title: 'Health check failed - process not running',
      service: 'sentinel',
      module: 'process-monitor',
      severity: 'p1',
      context: { command: this.config!.command },
      operator: 'process-monitor',
      action: 'health-check-failed',
      detail: `Health check: process ${this.config!.command} is not running`,
    });
  }
}
