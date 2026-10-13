import type { ChildProcess } from 'child_process';
import { EventCenter } from './event-center';
import { reportHealthCheckFailure, runHealthProbe } from './health-probe';
import { spawnInGroup, terminateProcessTree } from './process-tree';
import { eventKey } from './event-key';
import type { SentinelEvent, EventSeverity } from './types';

/** 命令串按空白切分（spawnProcess 每次启动复用，避免热路径重建正则） */
const RE_WHITESPACE = /\s+/;

/** 本轮输出尾部保留上限：仅供 restart-limit 事件的诊断上下文，故障判定不依赖它 */
const LAUNCH_OUTPUT_MAX_CHARS = 8192;

/** 故障签名匹配窗口：只需容纳最长签名（"address already in use" 等），远小于整段输出 */
const FAULT_WINDOW_CHARS = 1024;

/**
 * p3 生命周期事件（进程启动 / 正常退出）属于"事件"而非"待处理问题"。
 * 可执行告警/派单通道应据此过滤，避免每次进程启动都派发出噪声任务。
 */
export function isInformationalEvent(event: Pick<SentinelEvent, 'severity' | 'history'>): boolean {
  if (event.severity !== 'p3') return false;
  const action = event.history[0]?.action;
  return action === 'process-started' || action === 'process-exited';
}

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

// ─── 不可修复故障分类（纯函数） ─────────────────────────────────

/**
 * 重启是补救手段：重启修不好的故障不应消耗重启预算。
 * 这里只做"读取子进程自己打印的既成事实"——正确取值就写在错误串里，不含任何启发式阈值。
 */
export type NonRemediableFault =
  { readonly kind: 'none' } | { readonly kind: 'port-in-use'; readonly port: number | null };

/** 端口占用形态白名单：全部形态集中于此，治理产品可单点审计（大小写由调用方小写化后匹配） */
const PORT_IN_USE_FORMS: readonly RegExp[] = [
  /\beaddrinuse\b/,
  /\bport\s+(?:\d{1,5}\s+)?is\s+already\s+in\s+use\b/,
  /\baddress\s+already\s+in\s+use\b/,
];

/** 端口号提取形态：可读排布 "port 5173" 与 Node 错误串尾部 "127.0.0.1:5173"，按序取首个命中 */
const PORT_NUMBER_FORMS: readonly RegExp[] = [/\bport\s+(\d{1,5})\b/, /:(\d{1,5})\b/];

/** 判定本轮输出是否属于"重启修不好"的端口占用；端口号缺失时返回 null（不猜测、不报错） */
export function classifyNonRemediableFault(output: string): NonRemediableFault {
  const haystack = output.toLowerCase();
  if (!PORT_IN_USE_FORMS.some((form) => form.test(haystack))) return { kind: 'none' };
  for (const form of PORT_NUMBER_FORMS) {
    const match = haystack.match(form);
    const digits = match === null ? '' : match.slice(1).join('');
    if (digits.length > 0) return { kind: 'port-in-use', port: Number.parseInt(digits, 10) };
  }
  return { kind: 'port-in-use', port: null };
}

/**
 * 增量故障检测器：逐块累积一个短滑动窗口并即时匹配，命中即锁定。
 * 相比"对整段输出做一次分类"：跨块签名（"Port 51"|"73 is already"|" in use"）仍可识别；
 * 命中后锁定，随后再长的启动横幅也无法把已确认的故障挤出窗口（对截断免疫）；
 * 常驻内存恒为窗口大小。
 */
export class FaultDetector {
  private window = '';
  private latched: NonRemediableFault = { kind: 'none' };

  feed(chunk: string): void {
    this.window = (this.window + chunk).slice(-FAULT_WINDOW_CHARS);
    if (this.latched.kind === 'none') {
      const detected = classifyNonRemediableFault(this.window);
      if (detected.kind !== 'none') this.latched = detected;
    }
  }

  fault(): NonRemediableFault {
    return this.latched;
  }

  reset(): void {
    this.window = '';
    this.latched = { kind: 'none' };
  }
}

/** 保留本轮输出尾部，作为 restart-limit 事件的诊断上下文（截头不截尾） */
function appendBoundedOutput(current: string, chunk: string): string {
  return (current + chunk).slice(-LAUNCH_OUTPUT_MAX_CHARS);
}

// ─── 重启预算结算（纯函数） ───────────────────────────────────

/** 重启结局：restart 消耗一次预算并重拉；suppress 不消耗预算（重复请求或在途）；exhausted 预算已尽 */
export type RestartDecision =
  { readonly kind: 'restart' } | { readonly kind: 'suppress' } | { readonly kind: 'exhausted' };

/**
 * 进程退出与健康探测两条路径都会请求重启，历史上二者各累加同一计数器，
 * 一次失败可吃掉两次预算；in-flight 标志使同一次失败只结算一次。
 */
export function decideRestart(
  usedCount: number,
  maxCount: number,
  relaunchInFlight: boolean,
): RestartDecision {
  if (relaunchInFlight) return { kind: 'suppress' };
  if (usedCount >= maxCount) return { kind: 'exhausted' };
  return { kind: 'restart' };
}

/** 生命周期终态：耗尽预算 / 遇不可修复故障后监控永久静默，需与"从未启动"可区分 */
export type ProcessMonitorState = 'stopped' | 'running' | 'suppressed' | 'exhausted';

/** 进程命令级失败的两个来源：子进程 error 事件 / spawn 阶段异常 */
type CommandFailureKind = 'error' | 'launch-failed';

// ─── 事件上报（模块级工厂） ─────────────────────────────────

/** 进程监控事件规格：title + severity 决定稳定去重键，其余为可变载荷 */
interface ProcessEventSpec {
  title: string;
  severity: EventSeverity;
  action: string;
  detail: string;
  context: Record<string, unknown>;
}

/** 以管道 stdio、独立进程组启动子进程（不继承终端） */
function spawnProcess(cmd: string, args: string[], cwd: string): ChildProcess {
  // detectRunCommand 等调用方可能传入 "npm run dev" 式命令串；shell:false 下
  // spawn 会把整串当可执行文件路径导致 ENOENT，需拆分为可执行名 + 参数。
  const tokens = cmd.trim().split(RE_WHITESPACE);
  const executable = tokens[0];
  const resolvedArgs = args.length > 0 ? args : tokens.slice(1);
  return spawnInGroup(executable, resolvedArgs, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
}

/** 唯一事件上报出口：各处上报形状与去重语义完全一致，收敛为模块级工厂 */
function emitProcessEvent(
  eventCenter: EventCenter,
  projectId: string,
  spec: ProcessEventSpec,
): void {
  eventCenter.createEvent({
    projectId,
    title: spec.title,
    service: 'sentinel',
    module: 'process-monitor',
    severity: spec.severity,
    context: spec.context,
    operator: 'process-monitor',
    action: spec.action,
    detail: spec.detail,
    dedupeKey: eventKey(projectId, 'process-monitor', spec.title, spec.severity),
  });
}

// ─── 事件规格塑形（纯函数，不依赖实例状态） ─────────────────────

function startedSpec(
  cmd: string,
  pid: number | undefined,
  cwd: string,
  args: string[],
): ProcessEventSpec {
  return {
    title: `Process started: ${cmd}`,
    severity: 'p3',
    context: { command: cmd, pid, cwd, args },
    action: 'process-started',
    detail: `Process ${cmd} started with PID ${pid} in ${cwd}`,
  };
}

function stderrSpec(cmd: string, pid: number | undefined, text: string): ProcessEventSpec {
  return {
    title: `Process stderr: ${cmd}`,
    severity: 'p2',
    context: { command: cmd, pid, stderr: text.slice(0, 500) },
    action: 'process-stderr',
    detail: text.slice(0, 200),
  };
}

function exitedSpec(
  cmd: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  pid: number | undefined,
  severity: EventSeverity,
): ProcessEventSpec {
  return {
    title: `Process exited: ${cmd} (code=${code}, signal=${signal})`,
    severity,
    context: { command: cmd, exitCode: code, signal, pid },
    action: 'process-exited',
    detail: `Process ${cmd} exited with code ${code}, signal ${signal}`,
  };
}

function portInUseSpec(cmd: string, port: number | null): ProcessEventSpec {
  const where = port === null ? '目标端口' : `端口 ${port}`;
  return {
    title: `Port already in use by another process: ${cmd}`,
    severity: 'p2',
    context: { command: cmd, port },
    action: 'port-in-use-suppressed',
    detail: `${where} 已被其他进程占用，${cmd} 无法启动；重启无法释放该端口，已停止自动重启。请先结束占用该端口的进程，或改用其他端口。`,
  };
}

function restartLimitSpec(
  command: string,
  used: number,
  max: number,
  outputTail: string,
): ProcessEventSpec {
  const tail = outputTail.slice(-2000);
  return {
    title: 'Process restart limit reached',
    severity: 'p2',
    context: { command, restarts: used, outputTail: tail },
    action: 'restart-limit-reached',
    detail:
      `Process ${command} exhausted the restart budget ` +
      `(${used} of max ${max} restarts used); monitoring stopped. ` +
      `Last output: ${tail.slice(-500)}`,
  };
}

function processErrorSpec(cmd: string, message: string): ProcessEventSpec {
  return {
    title: `Process error: ${cmd}`,
    severity: 'p1',
    context: { command: cmd, error: message },
    action: 'process-error',
    detail: `Process ${cmd} error: ${message}`,
  };
}

function launchFailedSpec(cmd: string, message: string): ProcessEventSpec {
  return {
    title: `Failed to start process: ${cmd}`,
    severity: 'p1',
    context: { command: cmd, error: message },
    action: 'process-launch-failed',
    detail: `Failed to launch ${cmd}: ${message}`,
  };
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
  /** 已有一次健康探测在途；避免探测命令挂死时定时器每轮再叠加一个探测进程 */
  private probeInFlight = false;
  /** 本轮输出尾部（stdout + stderr），每次 launchProcess 清空；仅供事件诊断上下文 */
  private launchOutput = '';
  /** 本轮不可修复故障的增量检测器（对输出截断免疫） */
  private faultDetector = new FaultDetector();
  /** 已有一次重启在途；在途期间的再次请求不再消耗预算 */
  private relaunchInFlight = false;
  /** 终止原因；null 表示非终态，用于把"已终止"与"从未启动"区分开 */
  private terminalState: 'suppressed' | 'exhausted' | null = null;

  constructor(eventCenter: EventCenter) {
    this.eventCenter = eventCenter;
  }

  start(config: ProcessMonitorConfig): void {
    this.config = config;
    this.running = true;
    this.restarts = 0;
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
    const decision = decideRestart(this.restarts, maxRestarts, this.relaunchInFlight);

    if (decision.kind === 'exhausted') {
      this.emitRestartLimitReached(config.command, maxRestarts);
      this.terminalState = 'exhausted';
      this.halt();
      return decision;
    }
    if (decision.kind === 'suppress') return decision;

    terminateProcessTree(this.proc);
    this.proc = null;
    this.restarts++;
    this.relaunchInFlight = true;
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
    this.relaunchInFlight = false;
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
    this.emit(exitedSpec(cmd, code, signal, pid2, severity));

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
    this.emit(restartLimitSpec(command, this.restarts, maxRestarts, this.launchOutput));
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
