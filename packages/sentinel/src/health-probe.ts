import { spawnInGroup, terminateProcessTree } from './process-tree';
import { eventKey } from './event-key';
import type { EventCenter } from './event-center';

/** 命令串按空白切分（避免热路径重建正则） */
const RE_WHITESPACE = /\s+/;

/** 单次健康探测的硬超时：探测命令挂死时回收进程并判定为失败，防止定时器每轮叠加探测进程 */
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/** 健康探测命令配置：探测命令（可含内联参数）、显式参数覆盖与工作目录 */
export interface HealthProbeConfig {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
}

/** 健康探测回调：由调用方提供代际校验与失败通知钩子 */
export interface HealthProbeCallbacks {
  /** 探测启动后进程已重新拉起（代数已变）时返回 false，陈旧结果应被丢弃 */
  isEpochCurrent: () => boolean;
  /** 探测失败（非零退出 / 启动失败 / 超时）回调；output 为探测命令 stderr 摘要 */
  onFailure: (output?: string) => void;
  /** 探测结束（成功 / 失败 / 超时）后必被调用一次，用于解除在途互斥 */
  onSettled: () => void;
}

function resolveProbeCommand(config: HealthProbeConfig): { executable: string; args: string[] } | null {
  if (!config.command) return null;
  const tokens = config.command.trim().split(RE_WHITESPACE);
  if (tokens.length === 0) return null;
  const executable = tokens[0];
  const args = config.args && config.args.length > 0 ? config.args : tokens.slice(1);
  return { executable, args };
}

interface ProbeState {
  output: string;
  settled: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
}

function createProbeState(): ProbeState {
  return {
    output: '',
    settled: false,
    timeout: null,
  };
}

function finishProbe(
  state: ProbeState,
  callbacks: HealthProbeCallbacks,
  failed: boolean,
  out?: string,
): void {
  if (state.settled) return;
  state.settled = true;
  if (state.timeout) {
    clearTimeout(state.timeout);
    state.timeout = null;
  }
  if (callbacks.isEpochCurrent() && failed) callbacks.onFailure(out);
  callbacks.onSettled();
}

function startProbeProcess(
  command: { executable: string; args: string[] },
  config: HealthProbeConfig,
  state: ProbeState,
  finish: (failed: boolean, out?: string) => void,
): void {
  const probeProc = spawnInGroup(command.executable, command.args, {
    cwd: config.cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  state.timeout = setTimeout(() => {
    finish(true, 'health probe timed out');
    terminateProcessTree(probeProc);
  }, config.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);

  probeProc.stderr?.on('data', (chunk: Buffer) => {
    state.output += chunk.toString();
  });
  probeProc.on('exit', (code) => finish(code !== 0, state.output));
  probeProc.on('error', () => finish(true));
}

export function runHealthProbe(
  config: HealthProbeConfig,
  callbacks: HealthProbeCallbacks,
): void {
  const command = resolveProbeCommand(config);
  if (!command) {
    callbacks.onSettled();
    return;
  }
  try {
    const state = createProbeState();
    const finish = (failed: boolean, out?: string): void => finishProbe(state, callbacks, failed, out);
    startProbeProcess(command, config, state, finish);
  } catch {
    if (callbacks.isEpochCurrent()) callbacks.onFailure();
    callbacks.onSettled();
  }
}

export function reportHealthCheckFailure(
  eventCenter: EventCenter,
  projectId: string,
  command: string,
  probeOutput?: string,
): void {
  const title = 'Health check failed - process not running';
  const detail = probeOutput
    ? `Health probe for ${command} failed: ${probeOutput.slice(0, 200)}`
    : `Health check: process ${command} is not running`;
  eventCenter.createEvent({
    projectId,
    title,
    service: 'sentinel',
    module: 'process-monitor',
    severity: 'p1',
    context: { command, probeOutput: probeOutput?.slice(0, 500) },
    operator: 'process-monitor',
    action: 'health-check-failed',
    detail,
    dedupeKey: eventKey(projectId, 'process-monitor', title, 'p1'),
  });
}
