import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GarbageItem, GarbageCleanResult, GarbageRestoreResult, GarbageType } from './types';
import type { Issue } from '@zh/shared';
import { safeJoin, safeJoinReal, safeResolveReal } from '@zh/shared';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
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

export function mapDepcheckIssuesToGarbage(issues: Issue[]): GarbageItem[] {
  return issues
    .filter((i) => i.ruleId.includes('unused') || i.category === 'dependency')
    .map((i) => ({
      id: randomUUID(),
      type: 'unused-dependency' as const,
      path: i.file || i.message,
      size: 0,
      reason: i.message || `Unused dependency: ${i.ruleId}`,
    }));
}

export class GarbageScanner {
  async scan(projectPath: string): Promise<GarbageItem[]> {
    const items: GarbageItem[] = [];
    scanDirectory(projectPath, projectPath, items);
    return items;
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

function scanDirectory(dir: string, projectPath: string, items: GarbageItem[], depth = 0): void {
  if (depth > 14) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = safeJoin(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) scanDirectory(fullPath, projectPath, items, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    collectFileItem(entry, fullPath, projectPath, items);
  }
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

export interface GarbageCleanInput {
  id: string;
  path: string;
  size: number;
  type: string;
  reason?: string;
}

function isGarbageType(value: string): value is GarbageType {
  return ['unused-file', 'unused-dependency', 'dead-code', 'duplicate-code'].includes(value);
}

export const scanGarbage = (projectPath: string): Promise<GarbageItem[]> =>
  new GarbageScanner().scan(projectPath);

export function cleanGarbage(projectPath: string, items: GarbageCleanInput[]): GarbageCleanResult {
  const root = safeResolveReal(projectPath, '.');
  const state: CleanState = { batchId: '', trashDir: '', freedBytes: 0, cleaned: [], failed: [] };

  for (const item of items) {
    const type = validateCleanItem(item, state.failed);
    if (type === null) continue;
    const absPath = resolveItemPath(root, item, state.failed);
    if (absPath === null) continue;
    moveToTrash(item, type, absPath, root, state);
  }

  if (state.cleaned.length === 0 && state.batchId) {
    fs.rmSync(state.trashDir, { recursive: true, force: true });
    state.batchId = '';
  }
  return {
    batchId: state.batchId,
    cleaned: state.cleaned,
    freedBytes: state.freedBytes,
    failed: state.failed,
  };
}

interface CleanState {
  batchId: string;
  trashDir: string;
  freedBytes: number;
  cleaned: GarbageItem[];
  failed: string[];
}

function validateCleanItem(item: GarbageCleanInput, failed: string[]): GarbageType | null {
  if (!isGarbageType(item.type)) {
    failed.push(`${item.id}: 未知垃圾类型 ${item.type}`);
    return null;
  }
  if (item.type === 'unused-dependency') {
    failed.push(`${item.id}: unused-dependency 需通过包管理器移除，已跳过`);
    return null;
  }
  return item.type;
}

function resolveItemPath(root: string, item: GarbageCleanInput, failed: string[]): string | null {
  try {
    return safeResolveReal(root, item.path);
  } catch {
    failed.push(`${item.id}: 越界路径 ${item.path}`);
    return null;
  }
}

function moveToTrash(
  item: GarbageCleanInput,
  type: GarbageType,
  absPath: string,
  root: string,
  state: CleanState,
): void {
  try {
    if (!state.batchId) {
      const newBatchId = randomUUID();
      const newTrashDir = safeJoinReal(root, '.zhshield', 'trash', newBatchId);
      fs.mkdirSync(newTrashDir, { recursive: true });
      state.batchId = newBatchId;
      state.trashDir = newTrashDir;
    }
    const dest = safeJoinReal(state.trashDir, item.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(absPath, dest);
    state.freedBytes += item.size;
    state.cleaned.push({
      id: item.id,
      type,
      path: item.path,
      size: item.size,
      reason: item.reason ?? '',
    });
  } catch (err) {
    state.failed.push(`${item.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function restoreGarbage(projectPath: string, batchId: string): GarbageRestoreResult {
  const root = safeResolveReal(projectPath, '.');
  const batchDir = safeJoinReal(root, '.zhshield', 'trash', batchId);
  if (!fs.existsSync(batchDir)) {
    throw new Error(`trash batch 不存在: ${batchId}`);
  }

  const state: RestoreState = { restored: 0, restoredBytes: 0, failed: [] };
  restoreDirectory(batchDir, batchDir, root, state);

  if (state.failed.length === 0) {
    fs.rmSync(batchDir, { recursive: true, force: true });
  }
  return { restored: state.restored, restoredBytes: state.restoredBytes, failed: state.failed };
}

interface RestoreState {
  restored: number;
  restoredBytes: number;
  failed: string[];
}

function restoreDirectory(dir: string, batchDir: string, root: string, state: RestoreState): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'node_modules') continue;
    restoreEntry(entry, dir, batchDir, root, state);
  }
}

function restoreEntry(
  entry: fs.Dirent,
  dir: string,
  batchDir: string,
  root: string,
  state: RestoreState,
): void {
  const full = resolveFullPath(dir, entry.name, state.failed);
  if (full === null) return;
  if (entry.isDirectory()) {
    restoreDirectory(full, batchDir, root, state);
    return;
  }
  const rel = path.relative(batchDir, full);
  const dest = resolveDestPath(root, rel, state.failed);
  if (dest === null) return;
  if (fs.existsSync(dest)) {
    state.failed.push(`${rel}: 目标位置已有文件，跳过恢复`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(full, dest);
  state.restored += 1;
  state.restoredBytes += fs.statSync(dest).size;
}

function resolveFullPath(dir: string, entryName: string, failed: string[]): string | null {
  try {
    return safeJoinReal(dir, entryName);
  } catch (err) {
    failed.push(`${entryName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function resolveDestPath(root: string, rel: string, failed: string[]): string | null {
  try {
    return safeJoinReal(root, rel);
  } catch (err) {
    failed.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
