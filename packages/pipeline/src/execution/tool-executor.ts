/**
 * ToolExecutor —— 执行层第二层（《07》§7.2 / §7.4）。
 *
 * 硬指标 A12：同一 `(tool, targets, args)` 在一次运行中**只允许起一个进程**。
 * 这里有两条容易写错的语义，特意钉死：
 *   · 去重 key 对 targets 排序，避免「同一批文件、顺序不同」被当成两次任务；
 *   · 失败结果同样缓存（同一次运行内不重试），否则「一次失败 → 多域各重跑一次」
 *     会把进程次数打回 ≥3。跨运行重试由新实例（或 reset）负责。
 */
import type { ToolId } from '@zh/shared';

/** 一次工具调用请求（共享执行的去重维度） */
export interface ToolInvocation {
  tool: ToolId;
  targets: readonly string[];
  args?: readonly string[];
}

/** `executeOnce` 的返回：reused 表示复用了本次运行的既有结果（没有新起进程） */
export interface ExecuteOnceResult<T> {
  result: T;
  reused: boolean;
}

/** 稳定去重 key：tool + 排序后的 targets + 排序后的 args */
export function toolInvocationKey(invocation: ToolInvocation): string {
  const targets = [...invocation.targets].sort();
  const args = [...(invocation.args ?? [])].sort();
  // \u0000 分隔：文件路径里不可能出现 NUL，避免 `a/b` 与 `a` `b` 撞 key
  return `${invocation.tool}\u0000${targets.join('\u0001')}\u0000${args.join('\u0001')}`;
}

/**
 * 单次运行的共享执行器。
 *
 * 用法：一次全量运行生成一个实例；域向它申请调用，它保证同 key 只执行一次。
 * 并发安全：in-flight 阶段复用同一个 Promise，后到者 await 同一结果。
 */
export class ToolExecutor {
  private readonly results = new Map<string, Promise<unknown>>();
  private readonly counts = new Map<ToolId, number>();

  /**
   * 同 key 只执行一次。
   *
   * @param invocation 去重维度
   * @param run 真正起进程的函数
   */
  async executeOnce<T>(invocation: ToolInvocation, run: () => Promise<T>): Promise<ExecuteOnceResult<T>> {
    const key = toolInvocationKey(invocation);
    const cached = this.results.get(key);
    if (cached) {
      return { result: (await cached) as T, reused: true };
    }

    const count = (this.counts.get(invocation.tool) ?? 0) + 1;
    this.counts.set(invocation.tool, count);

    const promise = run();
    this.results.set(key, promise);
    return { result: await promise, reused: false };
  }

  /** 某工具（或全部）实际起进程的次数 —— A12 的断言入口 */
  invocationCount(tool?: ToolId): number {
    if (tool !== undefined) return this.counts.get(tool) ?? 0;
    let total = 0;
    for (const n of this.counts.values()) total += n;
    return total;
  }

  /** 新的一次运行：清空缓存与计数（失败结果不会跨运行复用） */
  reset(): void {
    this.results.clear();
    this.counts.clear();
  }
}
