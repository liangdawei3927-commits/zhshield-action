/**
 * 文件系统级垃圾检测器（垃圾清理域自有能力，代码实现）
 *
 * 覆盖：构建产物目录、系统残留 / 临时 / 备份文件、空文件。
 * 与 SOP 规则的分工：
 *   · 本检测器 —— 文件系统事实（是否存在、多大），无需规则驱动的模式判定，故不设 SOP 规则；
 *   · SOP 规则（garbage 域）—— 需要语义/工具判定的项：死代码（ts-prune）、
 *     重复代码（jscpd）、未使用依赖（depcheck），见 item-mapper.ts 的映射表。
 * 二者在 report.ts 合并为同一份 GarbageScanReport。
 *
 * 迁自 @zh/security/garbage-scanner.ts（T5）：垃圾 ≠ 安全，安全中心不再产出垃圾清单。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GarbageItem } from '@zh/shared';
import { safeJoin } from '@zh/shared';

const IGNORE_DIRS = new Set(['node_modules', '.git']);

/** 可再生成的构建产物根目录（仅项目根级识别，嵌套同名目录不视为垃圾） */
const BUILD_ARTIFACT_DIRS = new Set([
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.cache',
  'release',
  'dist-electron',
]);

const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const JUNK_EXTS = ['.log', '.tmp', '.bak', '.swp', '.swo'];
const JUNK_PREFIXES = ['npm-debug.log', 'yarn-error.log', 'pnpm-debug.log'];
const EMPTY_FILE_PATTERN = /^(index|main|app)\./i;

const MAX_DEPTH = 14;

/** 扫描文件系统级垃圾：构建产物 / 垃圾文件 / 空文件 */
export async function detectFsGarbage(projectPath: string): Promise<GarbageItem[]> {
  const items: GarbageItem[] = [];
  scanDirectory(projectPath, projectPath, items);
  return items;
}

function scanDirectory(dir: string, projectPath: string, items: GarbageItem[], depth = 0): void {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = safeJoin(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth === 0 && BUILD_ARTIFACT_DIRS.has(entry.name)) {
        items.push({
          id: randomUUID(),
          type: 'build-artifact',
          path: path.relative(projectPath, fullPath),
          size: dirSize(fullPath),
          reason: '可再生成的构建产物目录',
        });
        continue;
      }
      if (!IGNORE_DIRS.has(entry.name)) scanDirectory(fullPath, projectPath, items, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    collectFileItem(entry, fullPath, projectPath, items);
  }
}

/**
 * 递归统计目录体积。
 *
 * 与 scanDirectory 保持同一条忽略口径（node_modules / .git）：
 *   · 构建产物里嵌入 node_modules 时，递归进去既慢又可能踩符号链接环；
 *   · 代价是这类嵌套 node_modules 不计入体积 —— 属**少报**（承诺可释放空间偏小），
 *     不会出现"承诺得多、实际释放得少"的虚报。
 */
function dirSize(dir: string, depth = 0): number {
  if (depth > MAX_DEPTH) return 0;
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = safeJoin(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(full, depth + 1);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  } catch {
    return 0;
  }
  return total;
}

function collectFileItem(
  entry: fs.Dirent,
  fullPath: string,
  projectPath: string,
  items: GarbageItem[],
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return;
  }
  if (isJunkFile(entry.name)) {
    items.push({
      id: randomUUID(),
      type: 'unused-file',
      path: path.relative(projectPath, fullPath),
      size: stat.size,
      reason: `Unwanted file: ${entry.name}`,
    });
    return;
  }
  // 空文件（非常见入口）视为垃圾候选
  if (stat.size === 0 && !EMPTY_FILE_PATTERN.test(entry.name)) {
    items.push({
      id: randomUUID(),
      type: 'unused-file',
      path: path.relative(projectPath, fullPath),
      size: 0,
      reason: `Empty file: ${entry.name}`,
    });
  }
}

/** 判断文件名是否为垃圾文件（系统残留 / 临时文件 / 备份文件） */
function isJunkFile(name: string): boolean {
  if (JUNK_NAMES.has(name)) return true;
  if (JUNK_EXTS.some((ext) => name.endsWith(ext))) return true;
  if (JUNK_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (name.endsWith('~')) return true;
  return false;
}
