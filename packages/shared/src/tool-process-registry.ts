/**
 * 工具子进程登记簿：**域超预算时把还在跑的工具真的杀掉**（A13 / §7.5）。
 *
 * 为什么需要（2026-11-06 实测）：`withHardTimeout` 只是"不再等"，被放弃的执行仍在前台跑。
 * 体检域 150s 预算到点后，它的 `pysemgrep`/`semgrep-core` 仍在 199.7% CPU 上继续扫全仓 ——
 * 后果有三层：
 *   1. 该域已被记为 `unavailable`，这笔 CPU 产出**没有任何人消费**（纯浪费）；
 *   2. 它把机器负载顶上去，**下一个域**（security）起跑就在高负载里，又超预算 ——
 *      2026-11-05 三次 `bench:pipeline` 全部如此：inspect 150s 熔断 → security 120s 熔断；
 *   3. 笔记本上表现为"关掉窗口后风扇还在转"。
 *
 * 作用域而不是全局：桌面端可能同时有工具就绪面板在探测别的工具，杀全局会误伤。
 * 子进程按 `AsyncLocalStorage` 归属到**发起它的那次域执行**，`killAll()` 只清自己那一摊。
 *
 * 边界（宁可少杀，不可乱杀）：
 *   · 只在作用域内登记；作用域外（普通 CLI 命令、单测）不登记、不杀，行为与改动前一致；
 *   · 先 SIGTERM、宽限 `graceMs` 后仍未退出才 SIGKILL；
 *   · 只杀**直接子进程**：孙进程（pysemgrep → semgrep-core）由工具自身托管，
 *     父进程收到 SIGTERM 后会结束其子进程；不为此改成 detached 进程组（会影响 stdio 与 Ctrl-C 语义）。
 */
import type { ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ToolProcessScope {
  /** 本作用域内仍在跑的工具子进程 */
  readonly children: Set<ChildProcess>;
  /** 杀掉本作用域的全部子进程，返回收到信号的个数 */
  killAll(graceMs?: number): number;
}

const storage = new AsyncLocalStorage<ToolProcessScope>();

/** 当前是否在某个域执行作用域内（诊断/测试用） */
export function currentToolProcessScope(): ToolProcessScope | undefined {
  return storage.getStore();
}

/**
 * 在"可被整体终止"的作用域里执行一次域任务。
 * 嵌套调用复用外层作用域（不碎片化），与 `withToolRunScope` 的约定一致。
 */
export async function withToolProcessScope<T>(
  run: (scope: ToolProcessScope) => Promise<T>,
): Promise<T> {
  const existing = storage.getStore();
  if (existing) return run(existing);

  const children = new Set<ChildProcess>();
  const scope: ToolProcessScope = {
    children,
    killAll(graceMs = 3_000) {
      const victims = [...children];
      if (victims.length === 0) return 0;
      children.clear();

      for (const child of victims) {
        try {
          child.kill('SIGTERM');
        } catch {
          // 已经退出 / 句柄失效：无需处理
        }
      }

      // 宽限后仍未退出的补一刀：语义是"域已经作废，不允许它继续占核"
      const timer = setTimeout(() => {
        for (const child of victims) {
          if (child.exitCode !== null || child.signalCode !== null) continue;
          try {
            child.kill('SIGKILL');
          } catch {
            // 同上
          }
        }
      }, graceMs);
      // 不阻止进程退出（CLI 跑完就该退）
      timer.unref?.();
      return victims.length;
    },
  };

  return storage.run(scope, () => run(scope));
}

/**
 * 登记一个工具子进程。作用域外直接返回（不登记 = 不会被误杀，也不会拖住事件循环）。
 * 进程结束时自动从表里摘除，长跑进程不会让集合无限增长。
 */
export function trackToolProcess(child: ChildProcess): void {
  const scope = storage.getStore();
  if (!scope) return;
  scope.children.add(child);
  const drop = (): void => {
    scope.children.delete(child);
  };
  child.once('close', drop);
  child.once('exit', drop);
  child.once('error', drop);
}
