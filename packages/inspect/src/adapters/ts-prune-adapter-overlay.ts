import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeJoin } from '@zh/shared';

export const MONOREPO_OVERLAY_FILE = '.zhshield/tsconfig.ts-prune.monorepo.json';

/** 测试目录排除项匹配（测试是合法消费者，不再整体排除；仅跳过确属产物的部分） */
const SRC_TESTS_EXCLUDE_RE = /(^|\/)src\/__tests__\/?$/;

/**
 * monorepo overlay tsconfig。
 *
 * 背景（2026-09-21 实测确认）：ts-prune 用 `-p tsconfig.json` 相对 projectPath 运行，在 monorepo
 * 里命中仓库根 tsconfig —— 根 tsconfig 无 include 字段 → 全仓 TS 全量纳入（含脚本/夹具），无
 * jsx 支持 → .tsx 全量解析失败，无 DOM lib → 前端类型报错覆盖解析，且各包 @zh/* 路径映射断裂 →
 * App.tsx/PageShell/ScoreRing/getOrg 等被系统性误报为死代码。
 *
 * 解法：聚合各包 tsconfig 的 include/paths/exclude 为单一 overlay，jsx:preserve + DOM lib +
 * @zh/* 文件级 paths 指向各包 src/index.ts，单次执行（实测 ~17-25s / 858 条，6/6 已知符号判定正确）。
 */
export interface MonorepoPruneOverlay {
  compilerOptions: {
    target: string;
    module: string;
    moduleResolution: string;
    lib: readonly string[];
    jsx: string;
    strict: boolean;
    esModuleInterop: boolean;
    skipLibCheck: boolean;
    resolveJsonModule: boolean;
    noEmit: boolean;
    allowImportingTsExtensions: boolean;
    isolatedModules: boolean;
    baseUrl: string;
    paths: Record<string, string[]>;
  };
  include: string[];
  exclude: string[];
}

/** 逐包 tsconfig 中 overlay 需要继承的字段 */
interface PackageTsConfigShape {
  include?: string[];
  exclude?: string[];
  compilerOptions?: { paths?: Record<string, string[]> };
}

/** overlay 固定的编译选项（聚合语义，与单包编译无关） */
const OVERLAY_COMPILER_OPTIONS = {
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'bundler',
  lib: ['ES2023', 'DOM', 'DOM.Iterable'],
  jsx: 'preserve',
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  resolveJsonModule: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  isolatedModules: true,
} as const;

/**
 * JSONC→严格 JSON：仅在字符串外剥离行注释与块注释，保留字符串原样。
 *
 * 背景：autoperf 的 tsconfig.json 含 `// P7 试点` 注释（2026-09-21 实测），直接 JSON.parse
 * 会抛错 → 该包被静默跳过。注意必须识别字符串状态——裸正则 `//[^\n]*` 会误删字符串内的
 * `https://...` 等。状态机逐字符扫描，仅字符串外且遇 \ 转义时跳过两字符。
 */
export function stripJsoncComments(raw: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += raw[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 聚合 monorepo 各包 tsconfig 为单一 overlay，供 ts-prune 单次扫描。
 *
 * ⚠️ TS 路径解析基准不同（2026-09-21 实测确认，写错会静默扫描 0 文件）：
 *   · include/exclude —— 相对 **tsconfig 文件自身目录**（overlay 在 .zhshield/，故须 '../' 前缀指回项目根）；
 *   · baseUrl —— 相对 tsconfig 目录，设 '..' = 项目根；
 *   · paths —— 相对 **baseUrl**（= 项目根），故值用 './packages/...'，不能再带 '../'（会双重上跳）。
 * include 逐包追加；exclude 逐包聚合；paths 改写各包别名并映射 src/index.ts 为 @zh/<pkg>。
 * 非 monorepo（无 packages/<pkg>/tsconfig.json）→ null，调用方保持根 tsconfig.json 原行为。
 */
export function buildMonorepoPruneOverlay(
  projectPath: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
  exists: (p: string) => boolean = fs.existsSync,
): MonorepoPruneOverlay | null {
  const packagesRoot = path.join(projectPath, 'packages');
  const pkgDirs = readPackageDirs(packagesRoot);
  if (pkgDirs === null) return null;

  const { relRoot, fromConfigDir, fromBaseUrl } = createOverlayPathHelpers(projectPath);
  const { include, exclude, paths, foundPackage } = collectPackageOverlay(pkgDirs, {
    packagesRoot,
    fromConfigDir,
    fromBaseUrl,
    readFile,
    exists,
  });
  if (!foundPackage || include.length === 0) return null;

  return assembleOverlay(relRoot, paths, include, exclude);
}

/** 读取 packages 目录下的条目；目录不存在/不可读时返回 null */
function readPackageDirs(packagesRoot: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(packagesRoot, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * 计算 overlay 路径辅助函数。
 * fromConfigDir：overlay 所在目录（projectPath/.zhshield）到项目根的相对前缀（include/exclude 用）；
 * fromBaseUrl：paths 相对 baseUrl（= 项目根），带 './' 前缀，并归一化包内 './src/*' 等冗余写法。
 */
function createOverlayPathHelpers(projectPath: string): {
  relRoot: string;
  fromConfigDir: (p: string) => string;
  fromBaseUrl: (p: string) => string;
} {
  const overlayDir = path.dirname(path.join(projectPath, MONOREPO_OVERLAY_FILE));
  const relRoot = (path.relative(overlayDir, projectPath) || '.').split(path.sep).join('/');
  const fromConfigDir = (p: string): string => path.posix.join(relRoot, p);
  const fromBaseUrl = (p: string): string => `./${path.posix.normalize(p)}`;
  return { relRoot, fromConfigDir, fromBaseUrl };
}

/** collectPackageOverlay 的参数对象：包根目录、路径辅助函数与文件访问器 */
interface CollectPackageOverlayParams {
  packagesRoot: string;
  fromConfigDir: (p: string) => string;
  fromBaseUrl: (p: string) => string;
  readFile: (p: string) => string;
  exists: (p: string) => boolean;
}

/** aggregatePackage 的参数对象：包根目录、文件访问器、聚合目标集合与路径辅助函数 */
interface AggregatePackageParams {
  packagesRoot: string;
  readFile: (p: string) => string;
  include: string[];
  exclude: Set<string>;
  paths: Record<string, string[]>;
  fromConfigDir: (p: string) => string;
  fromBaseUrl: (p: string) => string;
}

/** aggregatePackageIncludes 的参数对象：包 tsconfig、聚合目标集合与路径辅助函数 */
interface AggregatePackageIncludesParams {
  cfg: PackageTsConfigShape;
  include: string[];
  exclude: Set<string>;
  fromConfigDir: (p: string) => string;
}

/** 逐包聚合 include/exclude/paths 与包入口映射 */
function collectPackageOverlay(
  pkgDirs: fs.Dirent[],
  params: CollectPackageOverlayParams,
): {
  include: string[];
  exclude: Set<string>;
  paths: Record<string, string[]>;
  foundPackage: boolean;
} {
  const { packagesRoot, fromConfigDir, fromBaseUrl, readFile, exists } = params;
  const include: string[] = [];
  const exclude = new Set([
    fromConfigDir('node_modules'),
    fromConfigDir('**/dist'),
    fromConfigDir('**/build'),
  ]);
  const paths: Record<string, string[]> = {};
  let foundPackage = false;

  for (const dirent of pkgDirs) {
    if (!dirent.isDirectory()) continue;
    const pkg = dirent.name;
    const pkgTsConfig = path.join(packagesRoot, pkg, 'tsconfig.json');
    if (!exists(pkgTsConfig)) continue;
    foundPackage = true;
    aggregatePackage(pkg, {
      packagesRoot,
      readFile,
      include,
      exclude,
      paths,
      fromConfigDir,
      fromBaseUrl,
    });
  }

  return { include, exclude, paths, foundPackage };
}

/** 聚合单个包：解析 tsconfig 后并入 include/exclude/paths 与包入口映射 */
function aggregatePackage(pkg: string, params: AggregatePackageParams): void {
  const { packagesRoot, readFile, include, exclude, paths, fromConfigDir, fromBaseUrl } = params;
  const pkgTsConfig = path.join(packagesRoot, pkg, 'tsconfig.json');
  const cfg = parsePackageTsConfig(pkgTsConfig, readFile);
  if (cfg === null) return;

  aggregatePackageIncludes(pkg, { cfg, include, exclude, fromConfigDir });
  aggregatePackagePaths(pkg, cfg, paths, fromBaseUrl);
}

/** 解析包 tsconfig（JSONC 容错：剥离注释后 JSON.parse）；坏配置返回 null */
function parsePackageTsConfig(
  pkgTsConfig: string,
  readFile: (p: string) => string,
): PackageTsConfigShape | null {
  try {
    return JSON.parse(stripJsoncComments(readFile(pkgTsConfig))) as PackageTsConfigShape;
  } catch {
    return null;
  }
}

/**
 * 聚合单个包的 include/exclude 到 overlay 集合。
 *
 * include 必须覆盖「测试」与「包根配置」两类合法消费者，否则它们对导出的引用不构成
 * 使用证据，会把有真实调用方的导出误判为死代码：
 *   · 各包 tsconfig 的 `include: ["src"]` 不含包根，而 vitest.config.ts 位于包根，
 *     导致 shared/src/vitest.config.base.ts 的 makeVitestConfig/packagesDir 零可见引用。
 *   · 各包 `exclude: ["src/__tests__"]` 把测试移出 program，而测试常是某导出唯一的消费者。
 * 仅排除编译产物（.js / .d.ts / dist）：它们是 include 通配带入的重复副本，
 * 参与分析会互相"引用"并掩盖真实死代码。
 */
function aggregatePackageIncludes(pkg: string, params: AggregatePackageIncludesParams): void {
  const { cfg, include, exclude, fromConfigDir } = params;
  const pkgIncludes = asStringArray(cfg.include);
  const scope = pkgIncludes.length > 0 ? pkgIncludes : ['src'];
  for (const inc of scope) {
    include.push(fromConfigDir(`packages/${pkg}/${inc}/**/*`));
  }
  // 包根配置文件（vitest.config.ts 等）不在 include 范围内，但它们是共享源码的真实消费者
  include.push(fromConfigDir(`packages/${pkg}/*.ts`));

  for (const ex of asStringArray(cfg.exclude)) {
    // 测试目录是合法消费者，不再整体排除；仅保留其中确属产物的部分
    if (SRC_TESTS_EXCLUDE_RE.test(ex)) continue;
    exclude.add(fromConfigDir(`packages/${pkg}/${ex}`));
  }
  // include 的 `**/*` 会带入同目录的 .js/.d.ts 编译产物，排除后只剩真实 TS 源码
  exclude.add(fromConfigDir(`packages/${pkg}/**/*.d.ts`));
  exclude.add(fromConfigDir(`packages/${pkg}/**/*.js`));
  exclude.add(fromConfigDir(`packages/${pkg}/**/*.js.map`));
}

/**
 * 聚合单个包的 paths 别名与包入口映射。
 *
 * `@zh/<pkg>` 无条件注册，不加 src/index.ts 存在性判断：映射指向不存在的文件与没有映射
 * 对解析结果等价（都会回退到常规解析），而门控会让 barrel 缺失的包丢失映射，使其全部
 * 导出被误判为死代码 —— 少一个文件被放大成整包误报，门控没有收益只有风险。
 */
function aggregatePackagePaths(
  pkg: string,
  cfg: PackageTsConfigShape,
  paths: Record<string, string[]>,
  fromBaseUrl: (p: string) => string,
): void {
  const pkgPaths = cfg.compilerOptions?.paths;
  if (pkgPaths) {
    for (const [alias, targets] of Object.entries(pkgPaths)) {
      paths[alias] = asStringArray(targets).map((t) => fromBaseUrl(`packages/${pkg}/${t}`));
    }
  }

  paths[`@zh/${pkg}`] = [fromBaseUrl(`packages/${pkg}/src/index.ts`)];
}

/** 组装最终 overlay 结构 */
function assembleOverlay(
  relRoot: string,
  paths: Record<string, string[]>,
  include: string[],
  exclude: Set<string>,
): MonorepoPruneOverlay {
  const sortedExclude: string[] = [];
  for (const item of exclude) sortedExclude.push(item);
  sortedExclude.sort();
  return {
    compilerOptions: { ...OVERLAY_COMPILER_OPTIONS, baseUrl: relRoot, paths },
    include: include.sort(),
    exclude: sortedExclude,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 写入 monorepo overlay 临时文件（非 monorepo 时跳过） */
export async function writeOverlayFile(
  overlay: MonorepoPruneOverlay | null,
  overlayAbsPath: string,
): Promise<void> {
  if (!overlay) return;
  await fs.promises.mkdir(path.dirname(overlayAbsPath), { recursive: true });
  await fs.promises.writeFile(overlayAbsPath, JSON.stringify(overlay, null, 2), 'utf8');
}

/** 清理 monorepo overlay 临时文件：不污染项目（写入 .zhshield/，git 已忽略） */
export async function cleanupOverlay(
  overlay: MonorepoPruneOverlay | null,
  overlayAbsPath: string,
): Promise<void> {
  if (!overlay) return;
  await fs.promises.rm(overlayAbsPath, { force: true }).catch(() => {});
}

/** 裸命令名（PATH 上解析到）：逐 PATH 目录查找可执行文件，避免执行 --version */
export async function findExecutableOnPath(command: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      await fs.promises.access(safeJoin(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      // 该目录无此命令，继续下一个 PATH 目录
    }
  }
  return false;
}
