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

/** 递归收集项目内全部相对路径（posix），跳过噪声目录与符号链接，输出按字典序排序（确定性）。 */
export function walkFiles(projectRoot: string): string[] {
  const out: string[] = [];
  const walk = (relDir: string): void => {
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
        walk(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk('');
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
