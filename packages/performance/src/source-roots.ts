/**
 * 源码根目录发现（source-roots.ts）
 *
 * 背景（T7）：complexity / tree-shaking 两个检测器原先各自写死
 * `SOURCE_DIRS = ['src']` 并只取 `SOURCE_DIRS[0]`，即「项目根部必须有 src/」。
 * 于是任何源码不在顶层 src/ 的项目都被静默扫描 **0 个文件**：
 *   · monorepo（pnpm/nx/turbo）—— 源码在 packages/*\/src、apps/*\/src
 *   · 前端框架 —— app/ 路由目录
 * 结果面板显示「复杂度 0 问题 / tree-shaking 0 问题」，而这是「没查」而非「没问题」。
 *
 * 本模块是该解析的**唯一来源**，供两个检测器共用；未发现任何源码根时由
 * PerformanceEngine 显式产出 `coverage.no-source-root` 提示，不静默放行。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeJoin } from '@zh/shared';

/** 单包项目常见的源码根目录名（刻意不含 lib/ — 多数项目 lib/ 是产物目录，会引入误报） */
const SINGLE_ROOT_DIRS: readonly string[] = ['src', 'app'];

/** workspace 容器目录：其下每个子包的 src/ 都要纳入 */
const WORKSPACE_DIRS: readonly string[] = ['packages', 'apps'];

/** workspace 子包数量上限（防超大仓遍历耗时） */
const MAX_WORKSPACE_CHILDREN = 100;

/**
 * 非生产代码目录：测试 / 夹具不参与「产品性能」判定。
 *
 * 测试里写 readFileSync、execSync、三层循环是常规做法，计入会显著抬高误报率
 * （产品以「误报率 > 30% 降级」为约束），故与 SKIP_DIRS 同等对待。
 */
export const NON_PRODUCTION_DIRS: ReadonlySet<string> = new Set<string>([
  '__tests__',
  '__mocks__',
  '__fixtures__',
  'tests',
  'test',
  'e2e',
]);

/** 非生产代码文件名（*.test.ts / *.spec.tsx / *.bench.ts 等） */
const NON_PRODUCTION_FILE_RE = /\.(test|spec|bench|benchmark|stories)\.[cm]?[jt]sx?$/i;

/** 是否为非生产代码文件名 */
export function isNonProductionFile(name: string): boolean {
  return NON_PRODUCTION_FILE_RE.test(name);
}

/** 源码文件扩展名（ts/tsx/js/jsx） */
export const SOURCE_EXTS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx'];

/** 遍历源码时跳过的目录名：依赖自身、构建产物与非生产代码 */
export const SKIPPED_SOURCE_DIRS: ReadonlySet<string> = new Set<string>([
  'node_modules',
  'dist',
  'build',
  'out',
  ...NON_PRODUCTION_DIRS,
]);

/** 安全读取文本文件；读取失败返回 null */
export function readTextSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 解析项目实际存在的源码根目录（绝对路径，去重且顺序稳定）。
 * 返回空数组表示「没有可扫描的源码根」——调用方应显式告知用户，而不是当成 0 问题。
 */
export function resolveSourceRoots(projectRoot: string): string[] {
  const roots: string[] = [];
  const push = (dir: string): void => {
    if (roots.includes(dir)) return;
    if (isDir(dir)) roots.push(dir);
  };

  for (const name of SINGLE_ROOT_DIRS) push(safeJoin(projectRoot, name));

  for (const container of WORKSPACE_DIRS) {
    const containerPath = safeJoin(projectRoot, container);
    if (!isDir(containerPath)) continue;
    for (const child of listDirs(containerPath).slice(0, MAX_WORKSPACE_CHILDREN)) {
      push(safeJoin(containerPath, child, 'src'));
    }
  }

  return roots;
}

/**
 * 跨多个源码根收集文件，共享同一份总量预算。
 *
 * 不用 `roots.flatMap((r) => collect(r, limit))`：那样每个根都各自扫满 limit，
 * 总量失控（monorepo 下 scanLimit 形同虚设）。
 */
export function collectFilesAcrossRoots(
  roots: readonly string[],
  collect: (root: string, limit: number) => string[],
  limit: number,
): string[] {
  const files: string[] = [];
  for (const root of roots) {
    if (files.length >= limit) break;
    files.push(...collect(root, limit - files.length));
  }
  return files;
}

/**
 * 递归收集单个根目录下匹配扩展名的源码文件（供 collectFilesAcrossRoots 分派）。
 *
 * 目录不存在、不可读一律按「无文件」静默处理，绝不抛异常。
 */
export function collectSourceFiles(
  dir: string,
  exts: readonly string[],
  skipDirs: ReadonlySet<string>,
  limit: number,
): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const visit = (current: string): void => {
    if (files.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (files.length >= limit) return;
      const full = safeJoin(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || NON_PRODUCTION_DIRS.has(entry.name)) continue;
        visit(full);
      } else if (
        entry.isFile() &&
        exts.includes(path.extname(entry.name)) &&
        !isNonProductionFile(entry.name)
      ) {
        files.push(full);
      }
    }
  };
  visit(dir);
  return files;
}
