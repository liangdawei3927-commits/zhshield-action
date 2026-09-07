/**
 * 孤儿数据对账（orphan-reconcile.ts）
 *
 * 桌面端"孤儿数据治理 L2"核心：后台服务模块（非 IPC handler），由 main.ts 启动时调用。
 * 对账三个独立维度：
 *   1. DB 活跃项目 vs projects.json 注册项目 → 目录缺失/空 → 确认孤儿（软删 + 画像移 trash）
 *   2. 疑似孤儿（目录仍有内容）→ 状态持久化 + 30 天升级为确认孤儿
 *   3. 纯画像孤儿（无 DB 活跃数据）→ 移 trash
 * 另含 TTL 物理清除（180 天软删行）。
 *
 * 设计纪律（06 §3.4 / §2.4）：只动 5 张 PROJECT_DATA_TABLES（scores / scanning_results /
 * debt_actions / debt_snapshots / sentinel_events），不碰 experiences 与规则缓存。
 * 所有清理均为"软删 + 移入 trash"，绝不物理删除画像或数据。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import {
  softDeleteProjectData,
  listActiveProjectIds,
  countActiveRows,
  purgeExpiredSoftDeleted,
} from '@zh/db';
import { AuditLogger } from '@zh/shared';
import { getDb } from './ipc-context';
import { PROJECTS_FILE } from './ipc/projects';

// ─── 常量 ───

/** 画像持久化目录（与 fingerprint PROFILE_DIR 约定一致，用 os 保证与画像实际落盘位置一致） */
const PROFILES_DIR = path.join(os.homedir(), '.zhshield', 'profiles');
/** 疑似孤儿状态文件 */
const STATE_FILE = path.join(os.homedir(), '.zhshield', 'orphan-state.json');
/** 疑似孤儿升级为确认孤儿的阈值（天） */
const UPGRADE_DAYS = 30;
/** TTL 物理清除阈值（天） */
const TTL_DAYS = 180;

// 画像 key 归一正则（与 fingerprint profile-store.ts 等价，不修改该包）
const NON_KEY_CHARS_RE = /[^a-zA-Z0-9_-]/g;
const FORWARD_SLASH_RE = /\//g;
const BACKSLASH_RE = /\\/g;
const LEADING_UNDERSCORE_RE = /^_+/;

// ─── 模块级单例 ───

/** 审计日志单例（写入失败静默 catch，永不阻断清理主流程） */
const auditLog = new AuditLogger();
/** 防重入标志 */
let inFlight = false;
/** 统一 warn 输出（错误对象只取 message） */
function warn(msg: string, err: unknown): void {
  console.warn(msg, err instanceof Error ? err.message : String(err));
}

// ─── 类型 ───

export type OrphanReason = 'dir_missing' | 'dir_empty' | 'dir_present_with_content';

export interface OrphanReconcileReport {
  scannedAt: string;
  activeProjectPaths: string[];
  confirmedOrphans: Array<{
    projectId: string;
    reason: OrphanReason;
    activeRowCounts: { table: string; count: number }[];
    profilesTrashed: string[];
  }>;
  suspectedOrphans: Array<{
    projectId: string;
    reason: 'dir_present_with_content';
    activeRowCounts: { table: string; count: number }[];
    firstSeenAt: string;
  }>;
  orphanProfilesTrashed: string[];
  purged: { table: string; deleted: number }[];
}

interface OrphanState {
  [projectId: string]: { firstSeenAt: string };
}

// ─── 画像 key 归一（等价于 fingerprint normalizeKey） ───

function normalizeKey(projectPath: string): string {
  return projectPath
    .replace(FORWARD_SLASH_RE, '_')
    .replace(BACKSLASH_RE, '_')
    .replace(LEADING_UNDERSCORE_RE, '')
    .replace(NON_KEY_CHARS_RE, '_');
}

/** 画像文件 key 是否匹配某项目 key（覆盖多引擎后缀如 `_zhiyan-codeshield`） */
function profileKeyMatches(fileKey: string, expectedKey: string): boolean {
  return fileKey === expectedKey || fileKey.startsWith(`${expectedKey}_`);
}

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
  db: ReturnType<typeof getDb>,
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
    .logOrphanCleanup({ action: 'soft_deleted', projectId, reason, activeRowCounts, profilesTrashed })
    .catch(() => {});
  confirmedOrphans.push({ projectId, reason, activeRowCounts, profilesTrashed });
}

// ─── 主流程 ───

export async function runOrphanReconcile(): Promise<OrphanReconcileReport> {
  const scannedAt = new Date().toISOString();
  const emptyReport = (): OrphanReconcileReport => ({
    scannedAt,
    activeProjectPaths: [],
    confirmedOrphans: [],
    suspectedOrphans: [],
    orphanProfilesTrashed: [],
    purged: [],
  });

  // 1. 防重入
  if (inFlight) return emptyReport();
  inFlight = true;

  try {
    // getDb 抛错（无持久化模式）→ 整体降级返回空报告，不抛到启动链
    const db = getDb();

    // 2. 读 projects.json → activeProjectPaths（parse 失败 / ENOENT → 空数组）
    let activeProjectPaths: string[] = [];
    try {
      const parsed = JSON.parse(await readFile(PROJECTS_FILE, 'utf-8')) as unknown;
      activeProjectPaths = (Array.isArray(parsed) ? parsed : [])
        .map((p) => (p as { path?: unknown })?.path)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
    } catch {
      // 忽略：无项目列表
    }

    // 3. candidates = active − activeProjectPaths（精确字符串比较）
    const active = new Set(listActiveProjectIds(db));
    const candidates = [...active].filter((id) => !activeProjectPaths.includes(id));

    const confirmedOrphans: OrphanReconcileReport['confirmedOrphans'] = [];
    const suspectedOrphans: OrphanReconcileReport['suspectedOrphans'] = [];
    const state = await loadOrphanState();
    const now = Date.now();
    const upgradeMs = UPGRADE_DAYS * 24 * 60 * 60 * 1000;

    // 4-6. 每个 candidate 判定（单项目失败仅 warn + 跳过，不中断整轮）
    for (const projectId of candidates) {
      try {
        const reason = await classifyDir(projectId);
        if (reason === 'dir_present_with_content') {
          // 疑似孤儿：状态持久化 + 30 天升级
          const existing = state[projectId];
          if (existing && now - new Date(existing.firstSeenAt).getTime() > upgradeMs) {
            await handleConfirmedOrphan(db, projectId, 'dir_present_with_content', confirmedOrphans);
            delete state[projectId];
          } else {
            const firstSeenAt = existing?.firstSeenAt ?? new Date().toISOString();
            state[projectId] = { firstSeenAt };
            await auditLog
              .logOrphanCleanup({ action: 'suspected', projectId, firstSeenAt })
              .catch(() => {});
            suspectedOrphans.push({
              projectId,
              reason: 'dir_present_with_content',
              activeRowCounts: countActiveRows(db, projectId),
              firstSeenAt,
            });
          }
        } else {
          // 确认孤儿（dir_missing | dir_empty）
          await handleConfirmedOrphan(db, projectId, reason, confirmedOrphans);
          delete state[projectId];
        }
      } catch (err) {
        warn(`[orphan-reconcile] 项目 ${projectId} 判定失败，跳过:`, err);
      }
    }
    await saveOrphanState(state);

    // 7. 画像孤儿扫描（独立维度）
    const orphanProfilesTrashed: string[] = [];
    try {
      const files = await fs.promises.readdir(PROFILES_DIR);
      const expectedKeys = new Set<string>();
      for (const p of [...activeProjectPaths, ...candidates, ...listActiveProjectIds(db)]) {
        expectedKeys.add(normalizeKey(p));
      }
      const trashDir = path.join(PROFILES_DIR, 'trash');
      await fs.promises.mkdir(trashDir, { recursive: true });
      const ts = Date.now();
      for (const file of files) {
        if (file === 'trash' || !file.endsWith('.json')) continue;
        const fileKey = file.slice(0, -'.json'.length);
        // 保护：跳过空 key 或含绝对路径分隔符的 key（防误删根路径）
        if (!fileKey || fileKey.includes('/') || fileKey.includes('\\')) {
          console.warn(`[orphan-reconcile] 跳过异常画像 key: ${fileKey}`);
          continue;
        }
        const isExpected = [...expectedKeys].some((k) => profileKeyMatches(fileKey, k));
        if (isExpected) continue;
        try {
          await fs.promises.rename(path.join(PROFILES_DIR, file), path.join(trashDir, `${ts}_${file}`));
          orphanProfilesTrashed.push(file);
        } catch (err) {
          warn(`[orphan-reconcile] 画像孤儿 ${file} 移入 trash 失败:`, err);
        }
      }
      if (orphanProfilesTrashed.length > 0) {
        await auditLog
          .logOrphanCleanup({
            action: 'profiles_trashed',
            projectId: '',
            profilesTrashed: orphanProfilesTrashed,
          })
          .catch(() => {});
      }
    } catch (err) {
      warn('[orphan-reconcile] 画像孤儿扫描失败:', err);
    }

    // 8. TTL 物理清除
    let purged: { table: string; deleted: number }[] = [];
    try {
      purged = purgeExpiredSoftDeleted(db, TTL_DAYS);
      if (purged.some((p) => p.deleted > 0)) {
        await auditLog.logOrphanCleanup({ action: 'purged', purged }).catch(() => {});
      }
    } catch (err) {
      warn('[orphan-reconcile] TTL 清除失败:', err);
    }

    return {
      scannedAt,
      activeProjectPaths,
      confirmedOrphans,
      suspectedOrphans,
      orphanProfilesTrashed,
      purged,
    };
  } catch (err) {
    warn('[orphan-reconcile] 对账失败，降级返回空报告:', err);
    return emptyReport();
  } finally {
    inFlight = false;
  }
}
