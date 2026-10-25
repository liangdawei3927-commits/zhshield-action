/**
 * 进程监控的「纯判定逻辑」：不可修复故障识别 + 重启预算结算。
 *
 * 与 {@link import('./process-monitor').ProcessMonitor} 解耦：这里全部是无实例状态的
 * 纯函数 / 独立小类，可单独单测（见 `__tests__/process-monitor.test.ts`）。
 */

import type { SentinelEvent } from './types';

/** 故障签名匹配窗口：只需容纳最长签名（"address already in use" 等），远小于整段输出 */
const FAULT_WINDOW_CHARS = 1024;

/**
 * p3 通知类事件属于"事件"而非"待处理问题"：进程生命周期（启动 / 正常退出）
 * 与文件变更通知（新增 / 内容变更）都只是状态播报，不含可执行的修复语义。
 * 可执行告警/派单通道应据此过滤，避免每次进程启动、每次文件写入都派发出噪声任务。
 *
 * p2 的 file-unlink（文件删除）不在此列：删除是需要人确认的真实信号。
 */
const INFORMATIONAL_P3_ACTIONS: ReadonlySet<string> = new Set([
  'process-started',
  'process-exited',
  'file-add',
  'file-change',
  'file-changed',
  'file-rename',
  // 未跟踪文件被删（临时文件 / 探针脚本 / 安装器临时产物）：删除属实但无需处理。
  // 与 p2 的 `file-unlink` 分开，才能既保留审计痕迹又不进默认告警列表。
  'file-unlink-untracked',
]);

export function isInformationalEvent(event: Pick<SentinelEvent, 'severity' | 'history'>): boolean {
  if (event.severity !== 'p3') return false;
  const action = event.history[0]?.action;
  return action !== undefined && INFORMATIONAL_P3_ACTIONS.has(action);
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
  private window: string = '';
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
