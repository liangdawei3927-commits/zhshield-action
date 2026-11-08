/**
 * FileIndex —— 执行层第一层（《07》§7.2）：一次遍历产出所有域要用的 targets。
 *
 * 为什么需要它：此前各域各自 walk 目录，同一棵树被扫 3–4 遍；重复代码问题因此
 * 在体检/重构/垃圾三处各报一次。FileIndex 只负责**列文件并分类**，不做任何检测。
 */
import { extname, join } from 'node:path';
import { safeReadDirEntries, toRelativePath } from '@zh/shared';

/** 目标分类（与 capability-registry 的 targets 对齐） */
export type FileTargetKind = 'source' | 'manifest' | 'lockfile' | 'build-output';

/** 单个目标：路径一律相对 projectRoot */
export interface FileTarget {
  path: string;
  kind: FileTargetKind;
}

/** 文件索引选项：`maxFiles` 是收录上限，超出即截断并标记 `truncated` */
export interface FileIndexOptions {
  /** 最大收录文件数，超出即截断并标记 truncated（防大仓库把内存打爆） */
  maxFiles?: number;
}

/** 一次遍历的结果 */
export interface FileIndexResult {
  projectRoot: string;
  source: string[];
  manifest: string[];
  lockfile: string[];
  /** 构建产物目录（相对路径）：只记目录，不下钻，避免把 dist 的每个文件都收进来 */
  buildOutputDirs: string[];
  targets: FileTarget[];
  truncated: boolean;
}

/** 一律不进入的目录（含隐藏目录） */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.zhshield',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
]);

/** 构建产物目录：记录但不遍历 */
const BUILD_OUTPUT_DIR_NAMES = new Set([
  'dist',
  'dist-electron',
  'build',
  'out',
  'coverage',
  '.next',
]);

/** 源码扩展名（各域只在 source 上跑 AST/静态检查） */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.rs',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.vue',
  '.svelte',
]);

/** 依赖清单（deps 域段） */
const MANIFEST_FILES = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'pom.xml',
  'Cargo.toml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
]);

/** 锁文件（deps 域 CVE / 图谱的唯一可信来源） */
const LOCKFILE_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'poetry.lock',
  'go.sum',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
]);

/**
 * 构建一次文件索引。
 *
 * 语义：目录不可读 → 跳过该目录（不抛错）；超过 maxFiles → 停止并置 `truncated`。
 * 各列表末尾排序，保证「同一仓库同一内容 → 同一索引」，便于缓存与断言。
 */
export function buildFileIndex(
  projectRoot: string,
  options: FileIndexOptions = {},
): FileIndexResult {
  const maxFiles = options.maxFiles ?? 20000;

  const source: string[] = [];
  const manifest: string[] = [];
  const lockfile: string[] = [];
  const buildOutputDirs: string[] = [];
  const pending: string[] = [projectRoot];
  let truncated = false;

  while (pending.length > 0 && !truncated) {
    const dir = pending.pop() as string;
    for (const entry of safeReadDirEntries(dir)) {
      const full = join(dir, entry.name);
      const rel = toRelativePath(projectRoot, full);

      if (entry.isDirectory()) {
        classifyDirectory({ name: entry.name, rel, full, pending, buildOutputDirs });
        continue;
      }

      if (!entry.isFile()) continue;

      classifyFile({ name: entry.name, rel, source, manifest, lockfile });

      if (source.length + manifest.length + lockfile.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
  }

  source.sort();
  manifest.sort();
  lockfile.sort();
  buildOutputDirs.sort();

  const targets: FileTarget[] = [
    ...source.map((path): FileTarget => ({ path, kind: 'source' })),
    ...manifest.map((path): FileTarget => ({ path, kind: 'manifest' })),
    ...lockfile.map((path): FileTarget => ({ path, kind: 'lockfile' })),
    ...buildOutputDirs.map((path): FileTarget => ({ path, kind: 'build-output' })),
  ];

  return { projectRoot, source, manifest, lockfile, buildOutputDirs, targets, truncated };
}

/** 目录分类入参（单对象参数：避免形参数量超过上限触发 long-parameter-list） */
interface ClassifyDirectoryParams {
  name: string;
  rel: string;
  full: string;
  pending: string[];
  buildOutputDirs: string[];
}

/**
 * 目录分类：构建产物目录只记录不遍历，其余非忽略目录入栈。
 *
 * 抽为独立函数是为了让 `buildFileIndex` 的遍历主体保持低嵌套
 * （复杂度规则 nestingDepth 上限 4；`else if` 会把深度加到 5）。
 */
function classifyDirectory(params: ClassifyDirectoryParams): void {
  const { name, rel, full, pending, buildOutputDirs } = params;
  if (BUILD_OUTPUT_DIR_NAMES.has(name)) {
    buildOutputDirs.push(rel);
    return;
  }
  if (!SKIP_DIR_NAMES.has(name) && !name.startsWith('.')) pending.push(full);
}

/** 文件分类入参（单对象参数：避免形参数量超过上限触发 long-parameter-list） */
interface ClassifyFileParams {
  name: string;
  rel: string;
  source: string[];
  manifest: string[];
  lockfile: string[];
}

/**
 * 文件分类：锁文件 → 依赖清单 → 源码，逐个匹配归入对应列表。
 *
 * 与 `classifyDirectory` 同样抽为独立函数以压低 `buildFileIndex` 的嵌套：
 * 三路 `else if` 链会把 nestingDepth 推到 5（规则上限 4）。
 */
function classifyFile(params: ClassifyFileParams): void {
  const { name, rel, source, manifest, lockfile } = params;
  if (LOCKFILE_FILES.has(name)) {
    lockfile.push(rel);
    return;
  }
  if (MANIFEST_FILES.has(name)) {
    manifest.push(rel);
    return;
  }
  if (SOURCE_EXTENSIONS.has(extname(name))) source.push(rel);
}

/** 按目标类型取相对路径列表（域向 Scheduler 申请 targets 时使用） */
export function targetsOfKind(index: FileIndexResult, kind: FileTargetKind): string[] {
  switch (kind) {
    case 'source':
      return index.source;
    case 'manifest':
      return index.manifest;
    case 'lockfile':
      return index.lockfile;
    case 'build-output':
      return index.buildOutputDirs;
  }
}
