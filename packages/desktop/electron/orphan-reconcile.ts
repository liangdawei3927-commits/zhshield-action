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

import * as path from 'node:path';
import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';

import { listActiveProjectIds, countActiveRows, purgeExpiredSoftDeleted } from '@zh/db';
import { getDb } from './ipc-context';
import { PROJECTS_FILE } from './ipc/projects';
import {
  PROFILES_DIR,
  TTL_DAYS,
  UPGRADE_DAYS,
  EMPTY_SINCE_KEY,
  profileKeyMatches,
  normalizeKey,
  auditLog,
  warn,
} from './orphan-reconcile-shared';
import type { Db } from './orphan-reconcile-shared';
import type {
  OrphanReconcileReport,
  OrphanReason,
  OrphanState,
  CleanResetReport,
} from './orphan-reconcile-types';
import {
  loadOrphanState,
  saveOrphanState,
  classifyDir,
  handleConfirmedOrphan,
} from './orphan-reconcile-state';
import { handleEmptyGrace } from './orphan-reconcile-reset';

export type { OrphanReason, OrphanReconcileReport, CleanResetReport } from './orphan-reconcile-types';

// ─── 模块级单例 ───

/** 防重入标志 */
let inFlight = false;

// ─── 主流程 ───

function emptyReport(scannedAt: string): OrphanReconcileReport {
  return {
    scannedAt,
    activeProjectPaths: [],
    confirmedOrphans: [],
    suspectedOrphans: [],
    orphanProfilesTrashed: [],
    purged: [],
  };
}

/** 读 projects.json → activeProjectPaths（parse 失败 / ENOENT → 空数组） */
async function loadActiveProjectPaths(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(PROJECTS_FILE, 'utf-8')) as unknown;
    return (Array.isArray(parsed) ? parsed : [])
      .map((p) => (p as { path?: unknown })?.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    // 忽略：无项目列表
    return [];
  }
}

/**
 * candidates = active − activeProjectPaths（精确字符串比较）
 * 仅绝对路径（用户项目）参与孤儿判定：packages/* 是 @zh/scoring 的模块分键（相对路径），
 * 不过滤会让 classifyDir 相对解析到 packages/desktop/packages/* → ENOENT → 误判「确认孤儿」
 * → softDeleteProjectData 把模块分整波软删（本次 42 行两波清空）。主项目绝对路径不受影响。
 */
function computeOrphanCandidates(db: Db, activeProjectPaths: string[]): string[] {
  const active = new Set([...listActiveProjectIds(db)].filter((id) => path.isAbsolute(id)));
  const candidates: string[] = [];
  for (const id of active) {
    if (!activeProjectPaths.includes(id)) candidates.push(id);
  }
  return candidates;
}

interface CandidateReconcileResult {
  confirmedOrphans: OrphanReconcileReport['confirmedOrphans'];
  suspectedOrphans: OrphanReconcileReport['suspectedOrphans'];
}

interface ReconcileSingleCandidateParams {
  db: Db;
  projectId: string;
  state: OrphanState;
  now: number;
  upgradeMs: number;
  confirmedOrphans: OrphanReconcileReport['confirmedOrphans'];
  suspectedOrphans: OrphanReconcileReport['suspectedOrphans'];
}

/** 单个 candidate 判定：确认孤儿（dir_missing/dir_empty）软删；疑似孤儿（有内容）按 30 天阈值升级或登记。单项目失败由调用方捕获跳过 */
async function reconcileSingleCandidate(params: ReconcileSingleCandidateParams): Promise<void> {
  const { db, projectId, state, now, upgradeMs, confirmedOrphans, suspectedOrphans } = params;
  const reason = await classifyDir(projectId);
  if (reason === 'dir_present_with_content') {
    // 疑似孤儿：状态持久化 + 30 天升级
    const raw = state[projectId];
    const existing = typeof raw === 'object' && raw !== null ? raw : undefined;
    if (existing && now - new Date(existing.firstSeenAt).getTime() > upgradeMs) {
      await handleConfirmedOrphan(db, projectId, 'dir_present_with_content', confirmedOrphans);
      delete state[projectId];
      return;
    }
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
    return;
  }
  // 确认孤儿（dir_missing | dir_empty）
  await handleConfirmedOrphan(db, projectId, reason, confirmedOrphans);
  delete state[projectId];
}

/** 4-6. 每个 candidate 判定（单项目失败仅 warn + 跳过，不中断整轮） */
async function reconcileCandidates(
  db: Db,
  candidates: string[],
  state: OrphanState,
): Promise<CandidateReconcileResult> {
  const confirmedOrphans: OrphanReconcileReport['confirmedOrphans'] = [];
  const suspectedOrphans: OrphanReconcileReport['suspectedOrphans'] = [];
  const now = Date.now();
  const upgradeMs = UPGRADE_DAYS * 24 * 60 * 60 * 1000;
  for (const projectId of candidates) {
    try {
      await reconcileSingleCandidate({
        db,
        projectId,
        state,
        now,
        upgradeMs,
        confirmedOrphans,
        suspectedOrphans,
      });
    } catch (err) {
      warn(`[orphan-reconcile] 项目 ${projectId} 判定失败，跳过:`, err);
    }
  }
  return { confirmedOrphans, suspectedOrphans };
}

interface OrphanProfileScan {
  expectedKeys: Set<string>;
  trashDir: string;
  ts: number;
}

function collectExpectedProfileKeys(
  db: Db,
  activeProjectPaths: string[],
  candidates: string[],
): Set<string> {
  const expectedKeys = new Set<string>();
  for (const p of [...activeProjectPaths, ...candidates, ...listActiveProjectIds(db)]) {
    expectedKeys.add(normalizeKey(p));
  }
  return expectedKeys;
}

async function trashOrphanProfileFile(
  file: string,
  scan: OrphanProfileScan,
): Promise<string | null> {
  if (file === 'trash' || !file.endsWith('.json')) return null;
  const fileKey = file.slice(0, -'.json'.length);
  // 保护：跳过空 key 或含绝对路径分隔符的 key（防误删根路径）
  if (!fileKey || fileKey.includes('/') || fileKey.includes('\\')) {
    console.warn(`[orphan-reconcile] 跳过异常画像 key: ${fileKey}`);
    return null;
  }
  const isExpected = [...scan.expectedKeys].some((k) => profileKeyMatches(fileKey, k));
  if (isExpected) return null;
  try {
    await fs.promises.rename(
      path.join(PROFILES_DIR, file),
      path.join(scan.trashDir, `${scan.ts}_${file}`),
    );
    return file;
  } catch (err) {
    warn(`[orphan-reconcile] 画像孤儿 ${file} 移入 trash 失败:`, err);
    return null;
  }
}

/** 7. 画像孤儿扫描（独立维度） */
// eslint-disable-next-line perf/perf-walk-requires-ignore -- 固定画像目录（PROFILES_DIR）单层 readdir，非递归树遍历，与 node_modules 无关
async function scanOrphanProfiles(
  db: Db,
  activeProjectPaths: string[],
  candidates: string[],
): Promise<string[]> {
  const orphanProfilesTrashed: string[] = [];
  try {
    const files = await fs.promises.readdir(PROFILES_DIR);
    const scan: OrphanProfileScan = {
      expectedKeys: collectExpectedProfileKeys(db, activeProjectPaths, candidates),
      trashDir: path.join(PROFILES_DIR, 'trash'),
      ts: Date.now(),
    };
    await fs.promises.mkdir(scan.trashDir, { recursive: true });
    for (const file of files) {
      const trashed = await trashOrphanProfileFile(file, scan);
      if (trashed) orphanProfilesTrashed.push(trashed);
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
  return orphanProfilesTrashed;
}

/** 8. TTL 物理清除 */
async function runTtlPurge(db: Db): Promise<{ table: string; deleted: number }[]> {
  let purged: { table: string; deleted: number }[] = [];
  try {
    purged = purgeExpiredSoftDeleted(db, TTL_DAYS);
    if (purged.some((p) => p.deleted > 0)) {
      await auditLog.logOrphanCleanup({ action: 'purged', purged }).catch(() => {});
    }
  } catch (err) {
    warn('[orphan-reconcile] TTL 清除失败:', err);
  }
  return purged;
}

export async function runOrphanReconcile(): Promise<OrphanReconcileReport> {
  const scannedAt = new Date().toISOString();
  // 1. 防重入
  if (inFlight) return emptyReport(scannedAt);
  inFlight = true;
  try {
    // getDb 抛错（无持久化模式）→ 整体降级返回空报告，不抛到启动链
    const db = getDb();
    const activeProjectPaths = await loadActiveProjectPaths();
    const candidates = computeOrphanCandidates(db, activeProjectPaths);
    const state = await loadOrphanState();
    const { confirmedOrphans, suspectedOrphans } = await reconcileCandidates(
      db,
      candidates,
      state,
    );
    await saveOrphanState(state);
    const orphanProfilesTrashed = await scanOrphanProfiles(db, activeProjectPaths, candidates);
    const purged = await runTtlPurge(db);
    let cleanReset: CleanResetReport | undefined;
    const emptySinceExisted = state[EMPTY_SINCE_KEY] !== undefined;
    try {
      cleanReset = await handleEmptyGrace(db, activeProjectPaths, state);
    } catch (err) {
      warn('[orphan-reconcile] 空项目集宽限处理失败:', err);
    }
    if (emptySinceExisted || cleanReset !== undefined || state[EMPTY_SINCE_KEY] !== undefined) {
      await saveOrphanState(state);
    }
    return {
      scannedAt,
      activeProjectPaths,
      confirmedOrphans,
      suspectedOrphans,
      orphanProfilesTrashed,
      purged,
      cleanReset,
    };
  } catch (err) {
    warn('[orphan-reconcile] 对账失败，降级返回空报告:', err);
    return emptyReport(scannedAt);
  } finally {
    inFlight = false;
  }
}

// ─── 周期巡检 ───

/** 首轮巡检延迟（启动后 30s，避开窗口创建高峰） */
const RECONCILE_STARTUP_DELAY_MS = 30_000;
/** 巡检周期：与桌面端 SOP 定时同步同频（ipc-context: syncInterval = 6 小时） */
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动周期巡检：确保 7 天空项目集宽限期在应用常驻期间到期也能自动触发全局重置。
 * 幂等：重复调用不会创建多个定时器。fire-and-forget，永不阻断主流程。
 */
export function startOrphanReconcileTimer(intervalMs = RECONCILE_INTERVAL_MS): void {
  if (reconcileTimer) return;
  setTimeout(() => {
    void runOrphanReconcile().catch(() => {});
  }, RECONCILE_STARTUP_DELAY_MS).unref?.();
  reconcileTimer = setInterval(() => {
    void runOrphanReconcile().catch(() => {});
  }, intervalMs);
  reconcileTimer.unref?.();
}

/** 停止周期巡检（测试 / 退出清理用） */
export function stopOrphanReconcileTimer(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}
