/**
 * 垃圾/构建产物目录扫描公共骨架（garbage-scan.ts）
 *
 * 背景：@zh/garbage 的文件系统检测器与 @zh/security 的 GarbageScanner 各自实现过
 * 一份「根层构建产物目录 + 垃圾文件 + 空文件」扫描 —— 目录遍历骨架、三类产项的
 * 字段与文案、空文件口径逐字节相同；真正因域而异的只有三处：忽略目录集、构建
 * 产物目录的体积统计口径、垃圾文件名规则集。本模块把相同部分收敛为一份，差异
 * 部分全部由调用方注入，从而两域各自保留自身口径。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeJoin } from './security/safe-path';
import { safeReadDirEntries } from './fs-safe';
import type { GarbageItem } from './types';

/** 递归深度上限（缺省值；与两域原实现同值 14） */
const DEFAULT_MAX_DEPTH = 14;

/**
 * 空文件白名单：`index.` / `main.` / `app.` 视为入口文件，0 字节不算垃圾。
 * 与 @zh/garbage 的 junk-rules、@zh/security 的 garbage-scanner 原口径一致。
 */
const EMPTY_FILE_PATTERN = /^(index|main|app)\./i;

/** 递归目录体积统计参数 */
export interface DirSizeOptions {
  /** 需要跳过的条目名（命中即不计入体积） */
  readonly ignoreNames: ReadonlySet<string>;
  /** 跳过判定是否仅对目录生效（true = 只在 isDirectory 分支内跳过；缺省对所有条目生效） */
  readonly dirsOnly?: boolean;
  /** 递归深度上限；超过该深度返回 0（缺省不限深度） */
  readonly maxDepth?: number;
}

/**
 * 递归统计目录体积（字节）。读取失败（目录不可读 / stat 失败）时按 0 计，
 * 与两域原实现一致：不抛异常，只少报体积，绝不虚报。
 */
export function dirSizeOf(dir: string, options: DirSizeOptions): number {
  const { ignoreNames, dirsOnly = false, maxDepth } = options;
  const walk = (current: string, depth: number): number => {
    if (maxDepth !== undefined && depth > maxDepth) return 0;
    let total = 0;
    try {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (ignoreNames.has(entry.name) && (!dirsOnly || entry.isDirectory())) continue;
        const full = safeJoin(current, entry.name);
        if (entry.isDirectory()) {
          total += walk(full, depth + 1);
          continue;
        }
        if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      }
    } catch {
      return 0;
    }
    return total;
  };
  return walk(dir, 0);
}

/** 垃圾/构建产物扫描参数：与域相关的口径全部在此注入 */
export interface GarbageScanOptions {
  /** 任意层级都不展开的目录名（依赖 / 缓存 / 本域状态目录） */
  readonly ignoreDirs: ReadonlySet<string>;
  /** 仅在根层（depth === 0）识别为构建产物目录的目录名 */
  readonly buildArtifactDirs: ReadonlySet<string>;
  /** 垃圾文件名判定（系统残留 / 临时文件 / 备份文件；规则集由各域自持） */
  readonly isJunkFileName: (name: string) => boolean;
  /** 根层构建产物目录的递归体积统计口径（各域忽略集合不同，故注入） */
  readonly measureDirSize: (dirPath: string) => number;
  /** 递归深度上限（缺省 14） */
  readonly maxDepth?: number;
}

/**
 * 扫描项目树，产出「根层可再生成构建产物目录 / 垃圾文件 / 空文件」三类垃圾项。
 *
 * 产出顺序即遍历顺序（readdirSync 返回序，目录先于其下文件）；目录不可读、
 * 文件 stat 失败均按静默跳过处理，绝不抛异常。
 */
export function scanGarbageDir(projectPath: string, options: GarbageScanOptions): GarbageItem[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const items: GarbageItem[] = [];

  const collectFileItem = (name: string, relativePath: string, size: number): void => {
    if (options.isJunkFileName(name)) {
      items.push({
        id: randomUUID(),
        type: 'unused-file',
        path: relativePath,
        size,
        reason: `Unwanted file: ${name}`,
      });
      return;
    }
    // 空文件（非常见入口）视为垃圾候选
    if (size === 0 && !EMPTY_FILE_PATTERN.test(name)) {
      items.push({
        id: randomUUID(),
        type: 'unused-file',
        path: relativePath,
        size: 0,
        reason: `Empty file: ${name}`,
      });
    }
  };

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const entry of safeReadDirEntries(dir)) {
      const fullPath = safeJoin(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0 && options.buildArtifactDirs.has(entry.name)) {
          items.push({
            id: randomUUID(),
            type: 'build-artifact',
            path: path.relative(projectPath, fullPath),
            size: options.measureDirSize(fullPath),
            reason: '可再生成的构建产物目录',
          });
          continue;
        }
        if (!options.ignoreDirs.has(entry.name)) visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      collectFileItem(entry.name, path.relative(projectPath, fullPath), stat.size);
    }
  };

  visit(projectPath, 0);
  return items;
}
