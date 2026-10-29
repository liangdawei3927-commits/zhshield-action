import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 云端 SOP 规则缓存的定位 —— CLI 侧唯一入口。
 *
 * 为什么需要这个模块（2026-10-29 补）：
 * 桌面端建 runner 时走 `pipeline-runner-factory.createLoadedRunner`，它**同时**载入
 * 内置模板与 `ZH_SOP_CACHE_DIR` 下的云端规则；而 CLI 的 `runPipeline` 只调了
 * `loadSopRules()`。后果不是"少查几条"，是**门禁整段失声**：
 * `guard.block.official.health-score` / `guard.block.official.test-coverage` 这两条
 * 阻断型门禁**只在云端下发**，内置模板里根本没有 ⇒ `evaluatePostScanGates()` 的
 * `total` 恒为 0 ⇒ pre-commit 与 CI 拿到的"绿灯"是一次从未发生的判定。
 *
 * 所以这里的职责只有一个：**如实回答「云端规则在哪、能不能用、多旧」**。
 * 三个必须遵守的约束：
 *   1. 不猜。目录存在但 `modules/` 不在（同步没跑过 / 被清空）同样算不可用 ——
 *      "目录存在"和"有规则"是两件事，后者才是判据。
 *   2. 显式胜过隐式。`ZH_SOP_CACHE_DIR` 一旦给出，就**不再**回退平台默认路径：
 *      CI/pre-commit 明确指定了规则源，却静默读到另一份，是最难查的失真。
 *   3. 不可用必须带原因。返回 `reason` 而不是 `undefined`，调用方才有话可说 ——
 *      静默降级到"仅内置"会让用户以为云端规则参与了判定。
 */

/** 桌面端写入云端规则缓存的子目录（与 electron/pipeline-host-core.ts 的 userData 布局同源） */
const DESKTOP_APP_DIR = path.join('@zh', 'desktop', 'sop-cache');

/** 缓存可用性的判定产物 */
export interface SopCacheResolution {
  /** 可用的缓存目录（`{dir}/modules/*.db` 所在父目录）；undefined = 不可用 */
  readonly dir?: string;
  /** 来源的人话说明（总是存在，进横幅） */
  readonly origin: string;
  /** 不可用的具体原因；`dir` 有值时也可能存在（解释为何选它 / 需要注意什么） */
  readonly reason?: string;
}

/** 定位所需的全部环境输入（显式传参，便于用例覆盖三平台而不改真机环境） */
export interface SopCacheEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
}

/** 平台默认的桌面端缓存目录 */
export function resolveDesktopCacheDir(input: SopCacheEnv): string {
  const { env, platform, homeDir } = input;
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', DESKTOP_APP_DIR);
  }
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, DESKTOP_APP_DIR);
  }
  // linux 及其它 POSIX：遵循 XDG
  const configHome = env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config');
  return path.join(configHome, DESKTOP_APP_DIR);
}

/** `{dir}/modules` 是否存在且为目录 —— 唯一可用性判据 */
function hasModulesDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'modules')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析云端规则缓存目录。
 *
 * 顺序：`ZH_SOP_CACHE_DIR`（显式）→ 平台默认桌面缓存 → 不可用。
 * 显式值存在但不可用时**直接返回不可用**，不静默回退 —— 见文件头约束 2。
 */
export function resolveSopCacheDir(input: SopCacheEnv): SopCacheResolution {
  const explicit = input.env.ZH_SOP_CACHE_DIR?.trim();
  if (explicit) {
    if (hasModulesDir(explicit)) {
      return { dir: explicit, origin: '环境变量 ZH_SOP_CACHE_DIR' };
    }
    return {
      origin: '环境变量 ZH_SOP_CACHE_DIR',
      reason: `已显式指定 ${explicit}，但其中没有 modules/ 目录（不会回退到桌面端缓存）`,
    };
  }

  const desktop = resolveDesktopCacheDir(input);
  if (hasModulesDir(desktop)) {
    return { dir: desktop, origin: '桌面端云同步缓存' };
  }
  return {
    origin: '桌面端云同步缓存',
    reason: `未找到 ${desktop}/modules（桌面端可能从未同步过云端规则，或尚未安装）`,
  };
}

/** 缓存新鲜度：以 modules/ 下最新规则文件的 mtime 为准 */
export interface CacheFreshness {
  /** 最新规则的落盘时间；读不到时为 undefined */
  readonly updatedAt?: Date;
  /** 距今毫秒数；时钟漂移导致未来时间时为 0 */
  readonly ageMs?: number;
  /** 规则文件数 */
  readonly fileCount: number;
}

/** 超过这个天数就提示"规则可能已过期"（云大脑按日同步设计） */
export const STALE_CACHE_DAYS = 7;

/** 读取缓存新鲜度。读不到不算错误，返回 fileCount=0 */
export function readCacheFreshness(cacheDir: string, now: Date = new Date()): CacheFreshness {
  let files: string[];
  try {
    files = fs.readdirSync(path.join(cacheDir, 'modules')).filter((f) => f.endsWith('.db'));
  } catch {
    return { fileCount: 0 };
  }
  let newest = 0;
  for (const file of files) {
    try {
      const { mtimeMs } = fs.statSync(path.join(cacheDir, 'modules', file));
      if (mtimeMs > newest) newest = mtimeMs;
    } catch {
      // 单个文件读不到不影响整体新鲜度判定
    }
  }
  if (newest === 0) return { fileCount: files.length };
  const updatedAt = new Date(newest);
  return { updatedAt, ageMs: Math.max(0, now.getTime() - newest), fileCount: files.length };
}

/** 把毫秒差写成「N 天 / N 小时 / N 分钟前」 */
export function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 取真实环境输入（生产路径专用；用例请构造 SopCacheEnv） */
export function currentSopCacheEnv(): SopCacheEnv {
  return { env: process.env, platform: process.platform, homeDir: os.homedir() };
}
