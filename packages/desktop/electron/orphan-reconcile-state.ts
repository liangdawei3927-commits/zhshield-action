import * as path from 'node:path';
import * as fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { softDeleteProjectData, countActiveRows } from '@zh/db';
import {
  PROFILES_DIR,
  STATE_FILE,
  normalizeKey,
  profileKeyMatches,
  auditLog,
  warn,
} from './orphan-reconcile-shared';
import type { Db } from './orphan-reconcile-shared';
import type { OrphanReason, OrphanReconcileReport, OrphanState } from './orphan-reconcile-types';

// ─── 状态文件 ───

async function loadOrphanState(): Promise<OrphanState> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as OrphanState) : {};
  } catch {
    return {};
  }
}

async function saveOrphanState(state: OrphanState): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    warn('[orphan-reconcile] 状态文件写入失败:', err);
  }
}

// ─── 目录判定 ───

async function classifyDir(dir: string): Promise<OrphanReason> {
  try {
    const stat = await fs.promises.stat(dir);
    if (!stat.isDirectory()) return 'dir_missing';
    const entries = await fs.promises.readdir(dir);
    return entries.some((e) => !e.startsWith('.')) ? 'dir_present_with_content' : 'dir_empty';
  } catch {
    return 'dir_missing';
  }
}

// ─── 画像移入 trash ───

/** 列出画像目录文件（目录不存在 → 空数组） */
async function listProfileFiles(profilesDir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(profilesDir);
  } catch {
    return [];
  }
}

async function moveProfilesToTrash(profilesDir: string, projectId: string): Promise<string[]> {
  const expectedKey = normalizeKey(projectId);
  const trashDir = path.join(profilesDir, 'trash');
  const trashed: string[] = [];
  const files = await listProfileFiles(profilesDir);
  if (files.length === 0) return trashed;
  await fs.promises.mkdir(trashDir, { recursive: true });
  const ts = Date.now();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fileKey = file.slice(0, -'.json'.length);
    if (!profileKeyMatches(fileKey, expectedKey)) continue;
    try {
      await fs.promises.rename(path.join(profilesDir, file), path.join(trashDir, `${ts}_${file}`));
      trashed.push(file);
    } catch (err) {
      warn(`[orphan-reconcile] 画像 ${file} 移入 trash 失败:`, err);
    }
  }
  return trashed;
}

// ─── 确认孤儿处理 ───

async function handleConfirmedOrphan(
  db: Db,
  projectId: string,
  reason: OrphanReason,
  confirmedOrphans: OrphanReconcileReport['confirmedOrphans'],
): Promise<void> {
  // 先取活跃行数（软删后 countActiveRows 将返回空，故在软删前记录）
  const activeRowCounts = countActiveRows(db, projectId);
  // (i) DB 软删（幂等）
  softDeleteProjectData(db, projectId);
  // (ii) 画像移入 trash
  const profilesTrashed = await moveProfilesToTrash(PROFILES_DIR, projectId);
  // (iii) 审计（失败静默，不阻断）
  await auditLog
    .logOrphanCleanup({
      action: 'soft_deleted',
      projectId,
      reason,
      activeRowCounts,
      profilesTrashed,
    })
    .catch(() => {});
  confirmedOrphans.push({ projectId, reason, activeRowCounts, profilesTrashed });
}

// ─── 对外导出 ───

export { loadOrphanState, saveOrphanState, classifyDir, moveProfilesToTrash, handleConfirmedOrphan };
