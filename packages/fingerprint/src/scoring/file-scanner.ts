import * as fs from 'fs';
import { safeJoin } from '@zh/shared';

/**
 * 文件扫描器 — 递归扫描项目目录，过滤构建产物与依赖目录。
 *
 * 工程化约束：
 * - 同步实现（profiler 主类提供 sync/async 两个入口，内部共用同步扫描）
 * - 深度与文件数上限，防止超大项目扫描卡死
 * - 过滤规则与 .gitignore 精神一致，但不解析 .gitignore（保持零依赖）
 */
export interface ScanResult {
  projectRoot: string;
  /** 相对路径文件列表 */
  files: string[];
  /** 快速查找集合 */
  fileSet: Set<string>;
  /** 配置文件内容缓存（按需懒加载，探测时调用 readConfig） */
  configCache: Map<string, string | null>;
}

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.svn',
  '.hg',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  'target',
  'vendor',
  '.gradle',
  '.idea',
  '.vscode',
]);

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_FILES = 20000;

export interface ScanOptions {
  maxDepth?: number;
  maxFiles?: number;
  ignoreDirs?: string[];
}

export function scanProject(projectRoot: string, opts: ScanOptions = {}): ScanResult {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...(opts.ignoreDirs ?? [])]);

  const { files, fileSet } = walkDirectoryTree(projectRoot, { maxDepth, maxFiles, ignoreDirs });

  return { projectRoot, files, fileSet, configCache: new Map() };
}

function walkDirectoryTree(
  projectRoot: string,
  limits: { maxDepth: number; maxFiles: number; ignoreDirs: Set<string> },
): { files: string[]; fileSet: Set<string> } {
  const files: string[] = [];
  const fileSet = new Set<string>();
  const stack: Array<{ dir: string; rel: string; depth: number }> = [
    { dir: projectRoot, rel: '', depth: 0 },
  ];

  while (stack.length > 0 && files.length < limits.maxFiles) {
    const { dir, rel, depth } = stack.pop()!;
    const entries = readDirEntries(dir);
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (files.length >= limits.maxFiles) break;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !limits.ignoreDirs.has(entry.name) && depth < limits.maxDepth) {
        stack.push({ dir: safeJoin(dir, entry.name), rel: childRel, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(childRel);
      fileSet.add(childRel);
    }
  }

  return { files, fileSet };
}

function readDirEntries(dir: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * 按需读取配置文件内容（带缓存）。
 * 探测器只在命中文件名时才读取内容，避免全量读取拖慢。
 * 返回 null 表示文件不存在或读取失败。
 */
export function readConfig(scan: ScanResult, relPath: string): string | null {
  if (scan.configCache.has(relPath)) return scan.configCache.get(relPath)!;
  if (!scan.fileSet.has(relPath)) {
    scan.configCache.set(relPath, null);
    return null;
  }
  try {
    const abs = safeJoin(scan.projectRoot, relPath);
    const content = fs.readFileSync(abs, 'utf-8');
    scan.configCache.set(relPath, content);
    return content;
  } catch {
    scan.configCache.set(relPath, null);
    return null;
  }
}

/**
 * 按扩展名统计文件数 — 用于主语言权重判定
 */
export function countByExtension(scan: ScanResult, exts: string[]): number {
  let count = 0;
  for (const f of scan.files) {
    const ext = f.slice(f.lastIndexOf('.') + 1);
    if (exts.includes(ext)) count++;
  }
  return count;
}

/** 判断文件是否存在（相对路径） */
export function hasFile(scan: ScanResult, relPath: string): boolean {
  return scan.fileSet.has(relPath);
}
