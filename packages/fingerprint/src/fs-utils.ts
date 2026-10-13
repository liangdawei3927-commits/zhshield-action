// 文件系统工具：确定性递归遍历 + 原始解析助手。无外部运行时依赖（node:fs 递归 + 正则行解析）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SKIP_DIRS } from './detector';
import { cachedWalkFiles } from './walk-cache';



/** 目录名是否属于噪声目录（vendored / 依赖产物 / 构建输出，判定依据 SKIP_DIRS） */
export function isNoiseDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

/** 列出项目根目录下的文件（不递归），返回 posix 相对路径，按字典序排序。 */
export function listRootFiles(projectRoot: string): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.isSymbolicLink())
    .map((e) => e.name)
    .sort();
}

/**
 * 探测真实项目根：projectPath 根目录命中任一标志文件名则直接返回；否则下探一层子目录
 * （跳过噪声目录与符号链接）看是否命中，仍未命中则返回 projectPath 本身。
 *
 * lockfile-detector 与 manifest-detector 此前各复制一份只差「标志文件名集合」的探测实现，
 * 此处收敛为唯一实现，标志文件判定由调用方以 hasMarker 注入。
 */
export function findMarkerProjectRoot(
  projectPath: string,
  hasMarker: (name: string) => boolean,
): string {
  if (listRootFiles(projectPath).some(hasMarker)) return projectPath;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    return projectPath;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || isNoiseDir(entry.name)) continue;
    const sub = path.join(projectPath, entry.name);
    if (listRootFiles(sub).some(hasMarker)) return sub;
  }
  return projectPath;
}

/** 递归遍历默认深度上限（目录层级；防止符号链接环之外的病态深树拖垮扫描）。 */
export const DEFAULT_MAX_DEPTH = 12;

/** 目录遍历选项：自定义层级上限（默认 DEFAULT_MAX_DEPTH）。 */
export interface WalkOptions {
  /** 目录层级上限（根目录=0 层）；达到上限不再下钻。默认 DEFAULT_MAX_DEPTH。 */
  readonly maxDepth?: number;
}

/** 递归收集项目内全部相对路径（posix），跳过噪声目录与符号链接，输出按字典序排序（确定性）。 */
export function walkFiles(projectRoot: string, options?: WalkOptions): string[] {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  // 经 walk-cache 走增量缓存 + 单飞记忆化；返回与冷全量遍历完全一致的文件列表，
  // 任何缓存失败都静默回退全量遍历（fail-open），不改变签名/排序/SKIP_DIRS 语义。
  return cachedWalkFiles(projectRoot, maxDepth);
}

/**
 * 递归收集匹配条件的子目录相对路径（posix，字典序）。命中即收且不再下钻
 * （macOS bundle 目录如 .xcodeproj 是叶子整体，不遍历内部），噪声目录与符号链接跳过。
 * 与 walkFiles 共用同一套忽略规则（SKIP_DIRS）与深度上限 —— 全包唯一递归遍历实现。
 */
export function findDirsMatching(
  projectRoot: string,
  match: (dirName: string) => boolean,
  options?: WalkOptions,
): string[] {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const out: string[] = [];
  const walk = (relDir: string, depth: number): void => {
    if (depth > maxDepth) return;
    const absDir = relDir === '' ? projectRoot : path.join(projectRoot, ...relDir.split('/'));
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || isNoiseDir(entry.name)) continue;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (match(entry.name)) {
        out.push(rel);
      } else {
        walk(rel, depth + 1);
      }
    }
  };
  walk('', 0);
  return out;
}

/** 读取文件文本（调用方需保证文件存在）。 */
export function readText(projectRoot: string, relPath: string): string {
  return fs.readFileSync(path.join(projectRoot, ...relPath.split('/')), 'utf-8');
}

/** 文件相对路径的父目录（posix；顶层文件返回 '.'）。 */
export function relDirname(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '.' : relPath.slice(0, idx);
}

/** 类型收窄：未知值是否为非空对象（严格 TS 下替代 `as` 转型）。 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}




