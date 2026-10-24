/**
 * 项目根解析（project-root.ts）
 *
 * 用户在 UI 中扫选的可能不是锁文件所在目录本身：
 * - pnpm workspace 子包（如 packages/desktop），锁文件在工作区根，需向上查找；
 * - 用户选中了包含项目的父目录（如选中 Desktop 下的项目外壳目录），锁文件在唯一子目录中。
 *
 * 本模块从用户所选目录解析"实际项目根（锁文件所在目录）"，
 * 供 desktop 接线层在 buildDependencyGraph / lockfileVerifier.verify / 基线读写前统一调用一次，
 * 避免在三处引擎里重复实现向上查找。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 与 graph-builder / lockfile-verifier 探测一致的可识别锁文件名 */
const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'poetry.lock',
  'Pipfile.lock',
] as const;

/** 向上查找的保守边界（层数）：workspace 嵌套通常 ≤ 3 层，10 层足够且避免误伤无关祖先 */
const MAX_UPWARD_LEVELS = 10;

/**
 * 向下探测时跳过的噪声目录（与 @zh/pipeline 的 resolveEffectiveProjectRoot 同口径）。
 * 容器目录里常混有构建产物与工具缓存，它们自身可能带锁文件，但不是用户项目。
 */
const NESTED_PROBE_NOISE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'release',
  '.turbo',
  '.cache',
]);

/** 受支持的清单文件：无清单的目录不算项目（防止 AI 工具缓存目录被当成项目） */
const MANIFEST_NAMES = ['package.json', 'pyproject.toml', 'Pipfile', 'requirements.txt'] as const;

/** 目录下是否存在任意受支持锁文件 */
export function hasRecognizedLockfile(dir: string): boolean {
  return LOCKFILE_NAMES.some((name) => fs.existsSync(path.join(dir, name)));
}

/** 目录下是否含可识别清单；package.json 额外要求可解析（损坏清单不算项目） */
function hasProjectManifest(dir: string): boolean {
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    try {
      JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      return true;
    } catch {
      return false;
    }
  }
  return MANIFEST_NAMES.slice(1).some((name) => fs.existsSync(path.join(dir, name)));
}

/** 从 start 向上寻找最近一个含锁文件的祖先目录（含自身）；找不到返回 null */
function findLockfileAncestor(start: string): string | null {
  let current = path.resolve(start);
  for (let depth = 0; depth <= MAX_UPWARD_LEVELS; depth++) {
    if (hasRecognizedLockfile(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break; // 已到文件系统根
    current = parent;
  }
  return null;
}

/**
 * 向下探测：仅当"恰好一个直接子目录同时含锁文件与清单"时返回该子目录；
 * 零个/多个返回 null（不猜测）。
 *
 * 必须同时过滤三类干扰，否则会与 @zh/pipeline 的解析结论相反（同一项目两个根）：
 * 1. 点开头目录（`.opencode` / `.vscode` / `.trae` 等工具自身的依赖目录）；
 * 2. 噪声目录（构建产物、依赖目录）；
 * 3. 只有锁文件、没有清单的目录（缓存/临时目录不是用户项目）。
 */
function findUniqueLockfileChild(dir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith('.') && !NESTED_PROBE_NOISE_DIRS.has(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .filter((candidate) => hasRecognizedLockfile(candidate) && hasProjectManifest(candidate));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * 从用户所选目录解析"实际项目根（锁文件所在目录）"：
 * 1. 自身含锁文件 → 原路径原样返回（保持既有行为）；
 * 2. 否则向上找最近含锁文件的祖先（覆盖 workspace 子包、项目子目录扫描）；
 * 3. 否则若自身不含锁文件但恰好唯一直接子目录含锁文件 → 返回该子目录（覆盖父目录扫描）；
 * 4. 都找不到 → 原路径原样返回（诚实保留"锁文件缺失"判定）。
 */
export function resolveProjectRoot(projectPath: string): string {
  const start = path.resolve(projectPath);
  if (hasRecognizedLockfile(start)) return start;
  return findLockfileAncestor(start) ?? findUniqueLockfileChild(start) ?? start;
}
