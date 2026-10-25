/**
 * 进程监控的「事件出口」：事件规格塑形（纯函数）+ 唯一上报通道 + 子进程启动。
 *
 * 拆出此文件的原因：事件标题 / severity / action / detail 的取值规则是审计对象
 * （去重键由 title + severity 派生），与监控状态机本身无关，独立成模块便于单点审查。
 */

import type { ChildProcess } from 'child_process';
import type { EventCenter } from './event-center';
import { spawnInGroup } from './process-tree';
import { eventKey } from './event-key';
import type { EventSeverity } from './types';

/** 命令串按空白切分（spawnProcess 每次启动复用，避免热路径重建正则） */
const RE_WHITESPACE = /\s+/;

/** 进程监控事件规格：title + severity 决定稳定去重键，其余为可变载荷 */
export interface ProcessEventSpec {
  title: string;
  severity: EventSeverity;
  action: string;
  detail: string;
  context: Record<string, unknown>;
}

/** 以管道 stdio、独立进程组启动子进程（不继承终端） */
export function spawnProcess(cmd: string, args: string[], cwd: string): ChildProcess {
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
export function emitProcessEvent(
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

export function startedSpec(
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

export function stderrSpec(cmd: string, pid: number | undefined, text: string): ProcessEventSpec {
  return {
    title: `Process stderr: ${cmd}`,
    severity: 'p2',
    context: { command: cmd, pid, stderr: text.slice(0, 500) },
    action: 'process-stderr',
    detail: text.slice(0, 200),
  };
}

/**
 * 进程退出事件的构造参数。
 *
 * `severity` 由调用方按退出码/信号自行判定后传入 —— 本模块只负责把参数
 * 组装成事件描述，不内置任何告警强度策略。
 */
export interface ExitedSpecParams {
  cmd: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  pid: number | undefined;
  severity: EventSeverity;
}

export function exitedSpec(params: ExitedSpecParams): ProcessEventSpec {
  const { cmd, code, signal, pid, severity } = params;
  return {
    title: `Process exited: ${cmd} (code=${code}, signal=${signal})`,
    severity,
    context: { command: cmd, exitCode: code, signal, pid },
    action: 'process-exited',
    detail: `Process ${cmd} exited with code ${code}, signal ${signal}`,
  };
}

export function portInUseSpec(cmd: string, port: number | null): ProcessEventSpec {
  const where = port === null ? '目标端口' : `端口 ${port}`;
  return {
    title: `Port already in use by another process: ${cmd}`,
    severity: 'p2',
    context: { command: cmd, port },
    action: 'port-in-use-suppressed',
    detail: `${where} 已被其他进程占用，${cmd} 无法启动；重启无法释放该端口，已停止自动重启。请先结束占用该端口的进程，或改用其他端口。`,
  };
}

export function restartLimitSpec(
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

export function processErrorSpec(cmd: string, message: string): ProcessEventSpec {
  return {
    title: `Process error: ${cmd}`,
    severity: 'p1',
    context: { command: cmd, error: message },
    action: 'process-error',
    detail: `Process ${cmd} error: ${message}`,
  };
}

export function launchFailedSpec(cmd: string, message: string): ProcessEventSpec {
  return {
    title: `Failed to start process: ${cmd}`,
    severity: 'p1',
    context: { command: cmd, error: message },
    action: 'process-launch-failed',
    detail: `Failed to launch ${cmd}: ${message}`,
  };
}
