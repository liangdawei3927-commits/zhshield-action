import { spawn } from 'child_process';
import { eventKey } from './event-key';
import type { EventCenter } from './event-center';

/** 命令串按空白切分（避免热路径重建正则） */
const RE_WHITESPACE = /\s+/;

/** 健康探测命令配置：探测命令（可含内联参数）、显式参数覆盖与工作目录 */
export interface HealthProbeConfig {
  command: string;
  args?: string[];
  cwd: string;
}

/** 健康探测回调：由调用方提供代际校验与失败通知钩子 */
export interface HealthProbeCallbacks {
  /** 探测启动后进程已重新拉起（代数已变）时返回 false，陈旧结果应被丢弃 */
  isEpochCurrent: () => boolean;
  /** 探测失败（非零退出 / 启动失败）回调；output 为探测命令 stderr 摘要 */
  onFailure: (output?: string) => void;
}

export function runHealthProbe(
  config: HealthProbeConfig,
  callbacks: HealthProbeCallbacks,
): void {
  if (!config.command) return;
  try {
    const tokens = config.command.trim().split(RE_WHITESPACE);
    const executable = tokens[0];
    const args =
      config.args && config.args.length > 0 ? config.args : tokens.slice(1);
    const probeProc = spawn(executable, args, {
      cwd: config.cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let output = '';
    probeProc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    probeProc.on('exit', (code) => {
      if (!callbacks.isEpochCurrent()) return;
      if (code !== 0) callbacks.onFailure(output);
    });
    probeProc.on('error', () => {
      if (!callbacks.isEpochCurrent()) return;
      callbacks.onFailure();
    });
  } catch {
    callbacks.onFailure();
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