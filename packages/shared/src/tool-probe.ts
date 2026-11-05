/**
 * 外部工具可用性探测（`<cmd> --version`）的进程内合并 —— A12 的第一个切片。
 *
 * 为什么要有这个模块（2026-11-03 进程级实测）：
 *   同一次 `pipeline --full` 里，同一把刀被反复探测：`gitleaks ×4`、`semgrep ×3`、
 *   `jscpd ×3`、`depcheck ×2`。每次探测都是一次真实进程（semgrep 冷启动实测 7.6s），
 *   而探测结果在一次运行内不会变。`capability-registry` 的 A12 要求"同一 (tool, args)
 *   一次运行只起一次进程"——`--version` 也是 args 的一种。
 *
 * 为什么不是"永久缓存"：
 *   桌面端是长驻进程。用户装完工具后若永久缓存 false，工具就永远显示"未安装"，
 *   唯一解法变成重启应用 —— 那比多起几次进程更糟。故默认只缓存 30s（覆盖一次扫描的
 *   探测密集期），并提供 `invalidateToolProbes()` 供刷新路径显式失效。
 *
 * 语义边界：
 *   · **超时取首个调用者的值**：同一 command 在 TTL 内共享那一次探测。若 20s 的调用者
 *     先进，5s 的调用者会等到 20s —— 但这只在工具本身就慢时发生，且总代价仍小于
 *     两次独立探测（原行为是各起各的进程）。
 *   · 探测失败同样缓存（ENOENT 也是一次真实 spawn，不该重复付）。
 *   · 本模块只做"探测"，不判断工具是否可用 —— 各调用方按自己的口径解读（见下）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  execFileAsync,
  isConclusiveExecFailure,
  snapshotExecFailure,
} from './tool-exec-primitives';
import { runOncePerScope } from './tool-run-scope';

/** 一次探测的原始结果。`ok` 只表示进程成功退出，不代表版本号可解析 */
export interface ToolProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /**
   * 失败是否"结论明确"。
   *   · `true` —— 进程存在但非零退出（`--version` 不支持等），或根本不存在（ENOENT/EACCES）。
   *     这些都是**稳定事实**，可以缓存。
   *   · `false` —— 超时 / 被信号杀掉 / 资源耗尽（EMFILE 等）。这是"没测出来"，不是"没有"，
   *     缓存它会把一次机器抖动放大成整轮"工具不可用"（2026-11-03 实测：load 30+ 时
   *     semgrep 冷启动超 20s，13 条安全规则全部降级为"未安装"）。
   */
  conclusive: boolean;
  probedAt: number;
}

/** 默认 TTL：覆盖一次扫描的探测密集期，又不至于让桌面端"装完工具看不到" */
const DEFAULT_TTL_MS = 30_000;

/**
 * 测试环境下默认关闭缓存。
 *
 * 为什么必须关：单测大量用 `vi.mock('node:child_process')` 伪造工具输出，而缓存是
 * **进程级**状态——同一 worker 里跑多个测试文件时会串味。2026-11-03 实测：
 * `rule-quality-gate.test.ts` 单独跑 5 条全绿，与 inspect 全套同进程批量跑则
 * `path-traversal` 真阳性"0 检出"——前一个文件把 semgrep 探成了不可用，门禁于是
 * 静默跳过扫描。那是测试互相污染，不是规则退化，但红得一模一样。
 *
 * 生产（CLI / 桌面 / CI 单次运行）不受影响。需要测缓存本身的用例用
 * `__resetToolProbeCache()` 显式开启。
 */
const CACHE_ENV_DISABLED =
  process.env.ZH_TOOL_PROBE_CACHE === 'off' ||
  (process.env.VITEST === 'true' && process.env.ZH_TOOL_PROBE_CACHE !== 'on');

/**
 * 缓存必须**进程级共享**，不能只是模块级。
 *
 * 本仓的 `@zh/*` 是按消费者注入副本的（见 AGENTS.md「注入副本陷阱」），而 CLI 的 bundle
 * 里也同时存在被内联的 shared 与从 node_modules 解析的 shared —— 同一个进程里可能有好几份
 * 本模块。模块级 `Map` 会让每份副本各探一次，进程内合并等于没做（2026-11-03 实测：
 * `--full` 一轮里 `semgrep / gitleaks / jscpd` 仍各探 3 次，就是三份副本各一份缓存）。
 * 挂到 `globalThis` 的 Symbol 上，副本再多也只有一份状态。
 */
const STATE_KEY = Symbol.for('zh.tool-probe.state.v1');

interface ProbeCacheEntry {
  at: number;
  promise: Promise<ToolProbeResult>;
}

interface ProbeState {
  ttlMs: number;
  enabled: boolean;
  cache: Map<string, ProbeCacheEntry>;
}

function state(): ProbeState {
  const host = globalThis as unknown as Record<symbol, ProbeState | undefined>;
  let shared = host[STATE_KEY];
  if (!shared) {
    shared = { ttlMs: DEFAULT_TTL_MS, enabled: !CACHE_ENV_DISABLED, cache: new Map() };
    host[STATE_KEY] = shared;
  }
  return shared;
}

/** 调整 TTL（测试与特殊宿主用；0 = 关闭缓存） */
export function setToolProbeTtlMs(ms: number): void {
  state().ttlMs = Math.max(0, Math.floor(ms));
}

/**
 * 失效缓存。不传参 = 全部失效（工具安装 / 卸载后的刷新路径应调它）；
 * 传参 = 只失效该命令（按可执行文件身份匹配，与写入同一口径）。
 */
export function invalidateToolProbes(command?: string): void {
  const { cache } = state();
  if (command === undefined) cache.clear();
  else cache.delete(identityOf(command));
}

/** 测试专用：清空缓存、恢复默认 TTL，并显式开启缓存（越过测试环境默认关闭） */
export function __resetToolProbeCache(): void {
  const shared = state();
  shared.cache.clear();
  shared.ttlMs = DEFAULT_TTL_MS;
  shared.enabled = true;
}

/**
 * 缓存 key = **可执行文件身份**，不是调用方传入的字符串。
 *
 * 为什么：同一把刀会以两种形态被探测 —— `tool-resolve`/`tool-manager` 传裸名
 * （`jscpd`），`inspect/tool-available` 传解析后的绝对路径（`/…/node_modules/.bin/jscpd`）。
 * 按字符串做 key 就是两份缓存，同一工具一次运行仍探两次（2026-11-03 实测 jscpd ×2）。
 * 归一化到 realpath 后，裸名经 PATH 查到的与适配器解析到的指向同一文件、同一 key。
 *
 * 保留语义边界：**不跨二进制的不同安装合并**（项目本地 eslint 与全局 eslint 是不同
 * realpath，各探各的），否则版本号会张冠李戴。Windows 不做归一化（PATHEXT 情形复杂，
 * 且本仓主要跑 macOS/Linux/CI）。
 */
function identityOf(command: string): string {
  if (process.platform === 'win32') return command;
  const isPath = command.includes('/') || command.includes(path.sep);
  if (isPath) {
    try {
      return fs.realpathSync(command);
    } catch {
      return command;
    }
  }
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    } catch {
      // 不可读的 PATH 项跳过即可
    }
  }
  return command;
}

/**
 * 这些 errno 表示"这次没测成"，不是"工具不存在"：资源耗尽或超时都可能自愈。
 * 判定口径与运行作用域重放共用（见 tool-exec-classification.ts），此处不再各写一份。
 */
/** 缓存条目上限：桌面端是**长驻进程**，探测缓存只会在读时自然过期、不会主动回收 —— 上限 + 扫过期兜底 */
const MAX_CACHE_ENTRIES = 256;

/**
 * 长驻进程的兜底回收：条目数触顶时先扫掉已过期项，仍触顶则丢掉最旧的一半。
 * 只影响内存占用，不影响语义（探测结果本就 30s 后失效）。
 */
function evictIfNeeded(cache: Map<string, ProbeCacheEntry>, ttlMs: number): void {
  if (cache.size < MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= ttlMs) cache.delete(key);
  }
  if (cache.size < MAX_CACHE_ENTRIES) return;
  const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of oldest.slice(0, Math.ceil(oldest.length / 2))) cache.delete(key);
}

async function executeProbe(command: string, timeoutMs: number): Promise<ToolProbeResult> {
  const probedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], { timeout: timeoutMs });
    return {
      ok: true,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      conclusive: true,
      probedAt,
    };
  } catch (err) {
    // 失败也要把已写出的输出带回来：部分工具非零退出时 stdout 仍有版本号
    const snap = snapshotExecFailure(err);
    // 有退出码/errno 才是硬结论：ENOENT（不存在）、EACCES（不可执行）、数字退出码（存在但拒绝）
    return {
      ok: false,
      stdout: snap.stdout,
      stderr: snap.stderr,
      conclusive: isConclusiveExecFailure(snap),
      probedAt,
    };
  }
}

/**
 * 真正的探测入口：**先用运行作用域合并，再用 TTL 缓存**。
 *
 * 两层解决的是两件不同的事：
 *   1. 作用域（`runOncePerScope`）—— 一次运行内同一可执行文件只真跑一次，
 *      与这次运行跑多久无关。实测一次 `--full` 200–400s，30s 的 TTL 挡不住
 *      探测点在多个窗口里重复（2026-11-05：jscpd ×3 / eslint ×2 / gitleaks ×2 / depcheck ×2）。
 *   2. TTL —— 长驻进程（桌面端）跨运行的新鲜度：装完工具不重启也能看见。
 *
 * 作用域外（单测、桌面刷新路径）行为与改动前完全一致。
 */
async function runProbe(command: string, timeoutMs: number): Promise<ToolProbeResult> {
  const probe = () => executeProbe(command, timeoutMs);
  if (!state().enabled) return probe();
  return runOncePerScope('tool-probe', identityOf(command), probe, (result) => result.conclusive);
}

/**
 * 探测某命令的 `--version`。同 command 在 TTL 内共享一次真实进程（single-flight：
 * 并发调用共享同一个 Promise，不会因为同时到达而起两个）。
 *
 * 只缓存**结论明确**的结果：成功、不存在、非零退出都缓存；超时/被信号杀掉则不缓存，
 * 下一次调用会重新探测——"没测出来"必须可重试，否则一次抖动会污染整轮判定。
 */
export function probeToolVersion(command: string, timeoutMs = 20_000): Promise<ToolProbeResult> {
  const shared = state();
  if (!shared.enabled || shared.ttlMs === 0) return runProbe(command, timeoutMs);

  const key = identityOf(command);
  const now = Date.now();
  const hit = shared.cache.get(key);
  if (hit && now - hit.at < shared.ttlMs) return hit.promise;

  const promise = runProbe(command, timeoutMs).then((result) => {
    if (!result.conclusive && shared.cache.get(key)?.promise === promise) {
      shared.cache.delete(key);
    }
    return result;
  });
  evictIfNeeded(shared.cache, shared.ttlMs);
  shared.cache.set(key, { at: now, promise });
  return promise;
}
