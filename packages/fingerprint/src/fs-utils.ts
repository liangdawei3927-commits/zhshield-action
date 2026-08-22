// 文件系统工具：确定性递归遍历 + 原始解析助手。无外部运行时依赖（node:fs 递归 + 正则行解析）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SKIP_DIRS } from './detector';

/** 相对路径统一为 posix 风格（'/' 分隔），保证跨平台可复现。 */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

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

/** 递归遍历默认深度上限（目录层级；防止符号链接环之外的病态深树拖垮扫描）。 */
export const DEFAULT_MAX_DEPTH = 12;

export interface WalkOptions {
  /** 目录层级上限（根目录=0 层）；达到上限不再下钻。默认 DEFAULT_MAX_DEPTH。 */
  readonly maxDepth?: number;
}

/** 递归收集项目内全部相对路径（posix），跳过噪声目录与符号链接，输出按字典序排序（确定性）。 */
export function walkFiles(projectRoot: string, options?: WalkOptions): string[] {
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
      if (entry.isSymbolicLink()) continue;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isNoiseDir(entry.name)) continue;
        walk(rel, depth + 1);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk('', 0);
  return out;
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

/** 解析 JSON 内容为记录类型；解析失败返回 null（空 catch 禁止 → 用返回值表达失败）。 */
export function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 取记录中字符串数组键（用于依赖名列表），非字符串数组返回空数组。 */
export function stringArrayFrom(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
