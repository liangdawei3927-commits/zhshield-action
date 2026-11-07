/**
 * 域超预算必须**真的杀死**工具子进程（A13 / §7.5）。
 *
 * 背景（2026-11-06 实测）：`withHardTimeout` 只停止等待，被放弃的执行还在前台跑。
 * 体检域 150s 预算到点、账本记 `unavailable` 之后，它的 `semgrep-core` 仍以 199.7% CPU
 * 扫全仓——产出无人消费，还把负载顶高，让下一个域接着超预算。
 *
 * 本文件锁住四件事：
 *   ① 作用域内起的工具进程被登记，`killAll()` 能把还在跑的进程终止（Promise 以信号失败收场）
 *   ② 正常结束的进程自动摘除，长跑进程不会让集合无限增长
 *   ③ 作用域外不登记（命令行单跑、单测不受影响），也就不会被误杀
 *   ④ 嵌套作用域复用同一个（嵌套域执行不碎片化登记表）
 */
import { describe, it, expect } from 'vitest';
import { execFileAsync } from '../tool-exec-primitives';
import {
  currentToolProcessScope,
  withToolProcessScope,
} from '../tool-process-registry';

/** 一个自会长睡的 node 进程：用于验证"还在跑"的进程能被杀掉 */
const LONG_RUNNING = ['-e', 'setTimeout(() => {}, 30000)'];

describe('tool-process-registry — 域作废时杀掉仍在跑的工具进程', () => {
  it('作用域内登记 → killAll 终止真实子进程，Promise 以信号失败收场', async () => {
    let killed = 0;
    let failure: { signal?: string | null; killed?: boolean } | undefined;

    await withToolProcessScope(async (scope) => {
      const pending = execFileAsync(process.execPath, LONG_RUNNING);
      // 让 spawn 真正落地
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(scope.children.size).toBe(1);
      killed = scope.killAll(200);

      try {
        await pending;
      } catch (err) {
        failure = err as { signal?: string | null; killed?: boolean };
      }

      // 被杀后自动从表里摘除
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(scope.children.size).toBe(0);
    });

    expect(killed).toBe(1);
    expect(failure).toBeDefined();
    expect(failure?.killed === true || failure?.signal === 'SIGTERM').toBe(true);
  }, 20_000);

  it('正常结束的进程自动摘除（长驻进程不会无限增长）', async () => {
    await withToolProcessScope(async (scope) => {
      const { stdout } = await execFileAsync(process.execPath, ['-e', 'console.log("ok")']);
      expect(stdout.trim()).toBe('ok');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(scope.children.size).toBe(0);
      expect(scope.killAll()).toBe(0); // 没有可杀的
    });
  }, 20_000);

  it('作用域外不登记：普通调用照常工作，也没有作用域可杀', async () => {
    expect(currentToolProcessScope()).toBeUndefined();
    const { stdout } = await execFileAsync(process.execPath, ['-e', 'console.log("plain")']);
    expect(stdout.trim()).toBe('plain');
    expect(currentToolProcessScope()).toBeUndefined();
  }, 20_000);

  it('嵌套作用域复用同一个登记表（不碎片化）', async () => {
    let failure: unknown;
    await withToolProcessScope(async (outer) => {
      await withToolProcessScope(async (inner) => {
        expect(inner).toBe(outer);
        // 外层负责杀掉，这里只接收失败，不阻塞等待
        execFileAsync(process.execPath, LONG_RUNNING).catch((err) => {
          failure = err;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        // 内层登记的就是外层那张表
        expect(inner.children.size).toBe(1);
      });

      expect(outer.children.size).toBe(1);
      expect(outer.killAll(200)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(failure).toBeDefined();
  }, 20_000);
});
