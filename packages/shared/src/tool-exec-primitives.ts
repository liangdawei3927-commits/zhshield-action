/**
 * 外部工具执行的**公共底座**：promisify 的 execFile、失败快照、以及「结论是否明确」的判定。
 *
 * 为什么集中到一处：`tool-probe.ts`（探测缓存）与 `tool-run-scope.ts`（运行作用域重放）
 * 都要起进程、都要把 child_process 的错误对象拍成快照、都要判断「这次失败算不算数」。
 * 这些口径一旦分叉，同一台机器上会出现「探测认为工具可用、扫描却重放了上一次的失败」
 * 这种自相矛盾的状态，排查成本极高。而「超时不算没装好」这条判断是 2026-11-03 实测
 * 踩出来的（load 30+ 时 semgrep 冷启动超 20s，13 条安全规则被整体判成"工具未安装"），
 * 写两份就一定会有一天只改了一份。
 */
import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import { trackToolProcess } from './tool-process-registry';

/**
 * 各模块共用的 promise 化 execFile（单一来源，避免每个模块各 promisify 一次）。
 *
 * 为什么不用 `promisify(execFile)`：promisify 只给结果、**不给 ChildProcess 句柄**，
 * 于是域超预算时无法把它杀掉（2026-11-06 实测：体检域熔断后 semgrep-core 仍以 199.7% CPU
 * 扫全仓，把负载顶高、连累下一个域）。用回调形态能拿到 `execFile` 的返回值（就是句柄），
 * 登记到域作用域后即可整体终止。解析/拒绝形状与 promisify 逐项一致：
 * 成功 `{ stdout, stderr }`；失败把 stdout/stderr 挂到 error 上再 reject。
 */
export function execFileAsync(
  file: string,
  args?: readonly string[],
  options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> & { child?: ChildProcess } {
  // 初始化为 noop：Promise 构造器同步执行并立刻覆盖，去掉 definite assignment 断言
  let resolveFn: (value: { stdout: string; stderr: string }) => void = () => undefined;
  let rejectFn: (reason: unknown) => void = () => undefined;
  const promise = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  }) as Promise<{ stdout: string; stderr: string }> & { child?: ChildProcess };

  const child = execFile(
    file,
    args as string[] | undefined,
    options,
    (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (err !== null) {
        const failed = err as Error & { stdout?: unknown; stderr?: unknown };
        failed.stdout = stdout;
        failed.stderr = stderr;
        rejectFn(err);
        return;
      }
      resolveFn({ stdout: stdout as string, stderr: stderr as string });
    },
  ) as ChildProcess;

  // 与 Node 的 promisify(execFile) 保持一致：句柄挂在 promise.child 上（部分调用方依赖它）
  promise.child = child;
  trackToolProcess(child);
  return promise;
}

/**
 * 这些 errno 表示「这次没测成」（资源耗尽 / 系统调用被中断），都可能自愈，
 * **不是**「工具不存在」这种稳定事实。缓存它们会把一次机器抖动固化成整轮判定。
 */
export const TRANSIENT_ERRNO: ReadonlySet<string> = new Set([
  'EMFILE',
  'ENFILE',
  'EAGAIN',
  'ETIMEDOUT',
  'EBUSY',
  'ENOBUFS',
]);

/** 从 child_process 错误对象里能读到的判定依据 */
export interface ExecFailureShape {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
}

/**
 * 失败的结论是否明确（明确才可缓存 / 在本次运行内重放）：
 *   · 被信号杀掉或超时 → 不明确（进程没跑完，结论未知）；
 *   · 数字退出码 → 明确（工具存在，只是以非零退出，如 gitleaks 命中密钥 exit 1）；
 *   · 硬 errno（ENOENT/EACCES 等）→ 明确；
 *   · TRANSIENT_ERRNO → 不明确。
 */
export function isConclusiveExecFailure(failure: ExecFailureShape): boolean {
  if (failure.killed || failure.signal) return false;
  const code = failure.code;
  if (typeof code === 'number') return true;
  if (typeof code !== 'string' || code.length === 0) return false;
  return !TRANSIENT_ERRNO.has(code);
}

/** 一次失败的可重放快照（stdout/stderr 一律收敛为 string） */
export interface ExecFailureSnapshot extends ExecFailureShape {
  stdout: string;
  stderr: string;
  message: string;
}

/**
 * 把 child_process 的错误对象拍成字段快照。保留 stdout/stderr —— 部分工具非零退出时
 * 输出里仍有合法结果（如 gitleaks 命中密钥时 exit 1、stdout 仍是 JSON 报告）。
 */
export function snapshotExecFailure(err: unknown): ExecFailureSnapshot {
  const raw = err as {
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  return {
    message: typeof raw.message === 'string' ? raw.message : 'Command failed',
    stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
    stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
    code: raw.code,
    killed: raw.killed,
    signal: raw.signal,
  };
}
