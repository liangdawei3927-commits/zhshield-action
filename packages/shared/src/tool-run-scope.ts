/**
 * 一次运行内的工具调用去重（A12 的执行面最小实现）。
 *
 * 为什么需要它：`gate: A12` 要求"同一 (tool, targets, args) 一次全量运行只起一次进程"。
 * 实测（2026-11-03，`scripts/lib/tool-spy.cjs` 进程级计数）：一轮 `--full` 里
 * `gitleaks detect --source <项目> --report-format json --report-path - --no-git`
 * 被起了 **3 次**，argv 逐字节相同 —— 因为这把刀有两套独立的调用实现（`inspect` 的
 * gitleaks 适配器、`security` 的密钥生命周期扫描），各扫各的，谁也不认识谁。
 *
 * 设计取舍：
 *   · **运行作用域（scope）显式**，不是时间窗。桌面端是长驻进程，"上一次扫描的结果"
 *     绝不能漏进下一次扫描 —— 用 TTL 会造出陈旧密钥结论。CLI 一次扫描开一个 scope，
 *     扫描结束即失效。用 AsyncLocalStorage 传递，避免把 scope 句柄一路穿参到每个适配器。
 *   · **只缓存结论明确的调用**：成功、非零退出（如 gitleaks 命中密钥时 exit 1 但 stdout
 *     仍是合法 JSON）都缓存并重放；超时/被信号杀掉/资源耗尽不缓存 —— 那是"没测出来"，
 *     必须可重试（同 `tool-probe.ts` 的口径）。
 *   · **key = command + argv + cwd**。`maxBuffer` 不参与：同一 argv 的输出规模不因 buffer 改变。
 *   · 重放错误时**克隆**错误对象（保留 stdout/stderr/code/killed/signal），调用方的
 *     catch 语义（如"从失败输出里捞 findings"）完全不变。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  execFileAsync,
  isConclusiveExecFailure,
  snapshotExecFailure,
} from './tool-exec-primitives';

export interface ToolRunScope {
  /** 便于日志排查：哪个入口开的 scope（如 'pipeline.full' / 'kernel.sop-inspect'） */
  readonly label: string;
  /** key → 一次调用的结果（或重放的错误快照） */
  readonly calls: Map<string, Promise<ToolRunOutcome>>;
  /** 统计：命中次数，供账本/诊断使用 */
  hits: number;
}

export interface ToolRunOptions {
  /** 可选字段写作 `?: T | undefined`：调用方常直接透传可能为 undefined 的运行时值 */
  cwd?: string | undefined;
  timeout?: number | undefined;
  maxBuffer?: number | undefined;
}

/** 一次调用的可重放快照：成功给 stdout/stderr，失败给错误的可克隆字段 */
interface ToolRunOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: {
    message: string;
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
}

const storage = new AsyncLocalStorage<ToolRunScope>();

/**
 * 逃生开关：`ZH_TOOL_RUN_DEDUP=off` 关闭去重（作用域仍会建立，但不重放结果）。
 * 用途：① 出问题时快速判定"是否去重引起"；② 需要对照实测派发次数时无需改代码。
 */
const DEDUP_DISABLED = process.env.ZH_TOOL_RUN_DEDUP === 'off';

/** 当前是否处在某个运行作用域内（诊断/测试用） */
export function currentToolRunScope(): ToolRunScope | undefined {
  return storage.getStore();
}

/**
 * 在运行作用域内执行 `fn`。已有作用域时**复用**（嵌套入口不碎片化缓存）。
 * 作用域结束即释放 —— 下一次扫描不会看到上一次的任何结果。
 */
export async function withToolRunScope<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (DEDUP_DISABLED || storage.getStore()) return fn();
  const scope: ToolRunScope = { label, calls: new Map(), hits: 0 };
  return storage.run(scope, fn);
}

function keyOf(command: string, args: readonly string[], options: ToolRunOptions): string {
  return `${command}\u0000${options.cwd ?? ''}\u0000${args.join('\u0000')}`;
}

function snapshotOfError(err: unknown): ToolRunOutcome {
  const snap = snapshotExecFailure(err);
  return {
    ok: false,
    stdout: snap.stdout,
    stderr: snap.stderr,
    error: {
      message: snap.message,
      code: snap.code,
      killed: snap.killed,
      signal: snap.signal,
    },
  };
}

/** 快照是否值得在本次运行内重放（结论明确才算）—— 判定口径与探测缓存共用，见 tool-exec-classification.ts */
function isConclusive(outcome: ToolRunOutcome): boolean {
  if (outcome.ok) return true;
  return isConclusiveExecFailure(outcome.error ?? {});
}

function rethrow(outcome: ToolRunOutcome): never {
  const err = outcome.error ?? { message: 'Command failed' };
  throw Object.assign(new Error(err.message), {
    code: err.code,
    killed: err.killed,
    signal: err.signal,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  });
}

async function rawRun(
  command: string,
  args: readonly string[],
  options: ToolRunOptions,
): Promise<ToolRunOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
    });
    return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (err) {
    return snapshotOfError(err);
  }
}

/**
 * 执行外部工具；在运行作用域内**同一 (command, argv, cwd) 只真正执行一次**，
 * 其余调用重放同一结果（成功）或同一错误快照（失败）。
 * 作用域外等价于直接 `execFile` —— 对调用方完全透明。
 *
 * 抛出语义与 `promisify(execFile)` 一致：失败时抛出带 stdout/stderr/code 的 Error。
 */
export async function runToolOnce(
  command: string,
  args: readonly string[],
  options: ToolRunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const scope = storage.getStore();
  if (!scope) {
    const outcome = await rawRun(command, args, options);
    if (outcome.ok) return { stdout: outcome.stdout, stderr: outcome.stderr };
    rethrow(outcome);
  }

  const key = keyOf(command, args, options);
  const cached = scope.calls.get(key);
  if (cached) {
    scope.hits += 1;
    const outcome = await cached;
    if (outcome.ok) return { stdout: outcome.stdout, stderr: outcome.stderr };
    rethrow(outcome);
  }

  const promise = rawRun(command, args, options).then((outcome) => {
    // 结论不明确的失败不进重放表：下次调用应真的重试
    if (!isConclusive(outcome)) scope.calls.delete(key);
    return outcome;
  });
  scope.calls.set(key, promise);
  const outcome = await promise;
  if (outcome.ok) return { stdout: outcome.stdout, stderr: outcome.stderr };
  rethrow(outcome);
}
