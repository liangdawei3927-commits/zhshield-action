/**
 * 垃圾清理域的清理 / 恢复能力（迁自 @zh/security/garbage-scanner.ts，T5）
 *
 * 语义保持与迁移前完全一致：
 *   · 清理 = 移入 <project>/.zhshield/trash/<batchId>/（项目内私有回收站，可恢复）
 *   · 未使用依赖不可在此清理（需包管理器移除），validateCleanItem 显式拒绝并记 failed
 *   · 路径一律经 safeResolveReal / safeJoinReal 校验，防越界
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeJoinReal, safeResolveReal } from '@zh/shared';
import { isDeletablePath, isDeletableType, isKnownGarbageType } from './deletable';
import type {
  GarbageCleanInput,
  GarbageCleanResult,
  GarbageItem,
  GarbageRestoreResult,
  GarbageType,
} from './types';

export function cleanGarbage(projectPath: string, items: GarbageCleanInput[]): GarbageCleanResult {
  const root = safeResolveReal(projectPath, '.');
  const state: CleanState = { batchId: '', trashDir: '', freedBytes: 0, cleaned: [], failed: [] };

  for (const item of items) {
    const type = validateCleanItem(item, state.failed);
    if (type === null) continue;
    const absPath = resolveItemPath(root, item, state.failed);
    if (absPath === null) continue;
    if (!authorizeDelete(item, absPath, root, state.failed)) continue;
    moveToTrash({ item, type, absPath, root, state });
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
  if (!isKnownGarbageType(item.type)) {
    failed.push(`${item.id}: 未知垃圾类型 ${item.type}`);
    return null;
  }
  if (!isDeletableType(item.type)) {
    failed.push(`${item.id}: ${item.type} 属需人工判断的分析结论，不支持批量清理`);
    return null;
  }
  return item.type;
}

/**
 * 删除授权：以 resolveItemPath 解析出的绝对路径为准（项目相对 POSIX 路径），
 * 而非原始 item.path —— 原始字符串未做规范化，`dist/../package.json` 这类
 * 伪装路径会用 `dist` 段骗过白名单却实际指向包根文件。须在 resolveItemPath
 * 之后调用，否则越界路径会被降级成普通拒绝而丢掉越界诊断。
 */
function authorizeDelete(
  item: GarbageCleanInput,
  absPath: string,
  root: string,
  failed: string[],
): boolean {
  const relativePath = path.relative(root, absPath).split(path.sep).join('/');
  if (isDeletablePath(relativePath)) return true;
  failed.push(`${item.id}: ${item.path} 非可再生路径，已拒绝（仅允许清理构建产物与垃圾文件）`);
  return false;
}

function resolveItemPath(root: string, item: GarbageCleanInput, failed: string[]): string | null {
  try {
    return safeResolveReal(root, item.path);
  } catch {
    failed.push(`${item.id}: 越界路径 ${item.path}`);
    return null;
  }
}

interface MoveToTrashParams {
  item: GarbageCleanInput;
  type: GarbageType;
  absPath: string;
  root: string;
  state: CleanState;
}

function moveToTrash(params: MoveToTrashParams): void {
  const { item, type, absPath, root, state } = params;
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
  assertSafeBatchId(batchId);
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

/** batchId 必须为单个安全路径段，防止 `..` 等值经规范化逃出 trash 目录 */
function assertSafeBatchId(batchId: string): void {
  const unsafe =
    batchId === '' ||
    batchId === '.' ||
    batchId === '..' ||
    batchId.includes('/') ||
    batchId.includes('\\');
  if (unsafe) {
    throw new Error(`非法 batchId: ${batchId}`);
  }
}

function restoreDirectory(dir: string, batchDir: string, root: string, state: RestoreState): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'node_modules') continue;
    restoreEntry({ entry, dir, batchDir, root, state });
  }
}

interface RestoreEntryParams {
  entry: fs.Dirent;
  dir: string;
  batchDir: string;
  root: string;
  state: RestoreState;
}

function restoreEntry(params: RestoreEntryParams): void {
  const { entry, dir, batchDir, root, state } = params;
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
