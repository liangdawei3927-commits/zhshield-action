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
  listSoftDeletedProjectIds,
  countActiveRows,
  purgeExpiredSoftDeleted,
} from '@zh/db';
import { AuditLogger } from '@zh/shared';
import { getDb, sopCache, wisdomBrainSync } from './ipc-context';
import { PROJECTS_FILE } from './ipc/projects';
import { saveCapabilityRefs, loadCapabilityRefs } from './capability-refs';

// ─── 常量 ───

/** 画像持久化目录（与 fingerprint PROFILE_DIR 约定一致，用 os 保证与画像实际落盘位置一致） */
const PROFILES_DIR = path.join(os.homedir(), '.zhshield', 'profiles');
/** 疑似孤儿状态文件 */
const STATE_FILE = path.join(os.homedir(), '.zhshield', 'orphan-state.json');
/** 疑似孤儿升级为确认孤儿的阈值（天） */
const UPGRADE_DAYS = 30;
/** TTL 物理清除阈值（天） */
const TTL_DAYS = 180;
/** 空项目集全局重置宽限期（天）：删除全部项目后进入宽限，超期则彻底清除本地残留 */
const EMPTY_GRACE_DAYS = 7;
/** 空项目集宽限期毫秒数 */
const EMPTY_GRACE_MS = EMPTY_GRACE_DAYS * 24 * 60 * 60 * 1000;
/** state 中空项目集宽限起点的保留键（与 projectId 索引键区分） */
const EMPTY_SINCE_KEY = '__orphan_empty_since__';

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

/** 孤儿判定原因：目录缺失 / 目录为空 / 目录存在但仍有活跃数据 */
export type OrphanReason = 'dir_missing' | 'dir_empty' | 'dir_present_with_content';

/** 孤儿项目核对报告：确认/疑似孤儿清单、已回收画像与已清理的表行数 */
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
  /** 空项目集全局重置结果（宽限未到期 / 无残留 → undefined） */
  cleanReset?: CleanResetReport;
}

interface OrphanState {
  /** 疑似孤儿项目 → 首次发现时刻（升级阈值起算）；保留键 __orphan_empty_since__ 存空项目集宽限起点（epoch ms） */
  [projectId: string]: { firstSeenAt: string } | number | undefined;
}

/** 空项目集全局重置结果（宽限期到期后彻底清除本地残留的明细） */
export interface CleanResetReport {
  /** 宽限起点（epoch ms） */
  emptySince: number;
  /** 画像 trash 是否被清除 */
  profilesTrashCleared: boolean;
  /** SOP 规则缓存是否被清空 */
  sopCacheCleared: boolean;
  /** 被物理删除的工具规则 id 列表 */
  removedTools: string[];
  /** 能力引用账本是否被清空 */
  capabilityRefsCleared: boolean;
  /** DB 各表强清的软删行数 */
  purged: { table: string; deleted: number }[];
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

// ─── 空项目集宽限 + 全局重置 ───

/** 本地是否存在待清理残留（画像 trash / DB 软删行 / 工具规则 / 能力账本） */
async function hasLocalResiduals(db: ReturnType<typeof getDb>): Promise<boolean> {
  if (await hasTrashResiduals()) return true;
  if (await hasCapabilityRefsResiduals()) return true;
  if (hasSoftDeletedRows(db)) return true;
  return await hasToolRuleResiduals();
}

async function hasTrashResiduals(): Promise<boolean> {
  try {
    const entries = await fs.promises.readdir(path.join(PROFILES_DIR, 'trash'));
    return entries.length > 0;
  } catch {
    // trash 不存在 → 无画像残留
    return false;
  }
}

async function hasCapabilityRefsResiduals(): Promise<boolean> {
  try {
    const refs = await loadCapabilityRefs();
    return Object.keys(refs.capabilities).length > 0;
  } catch {
    // 账本不可读 → 视为无残留
    return false;
  }
}

function hasSoftDeletedRows(db: ReturnType<typeof getDb>): boolean {
  try {
    return listSoftDeletedProjectIds(db).length > 0;
  } catch {
    // DB 不可查 → 视为无残留
    return false;
  }
}

async function hasToolRuleResiduals(): Promise<boolean> {
  try {
    const toolIds = wisdomBrainSync.getRuleSync().getUnfilteredToolIds();
    for (const toolId of toolIds) {
      try {
        await fs.promises.stat(wisdomBrainSync.getRuleSync().getRuleDir(toolId));
        return true;
      } catch {
        // 该工具无规则目录 → 继续
      }
    }
  } catch {
    // 工具同步未初始化 → 视为无残留
  }
  return false;
}

/** 全局重置：彻底清除全部本地残留（画像 trash / SOP 缓存 / 工具规则 / 能力账本 / DB 软删行） */
async function resetToCleanState(
  db: ReturnType<typeof getDb>,
  emptySince: number,
): Promise<CleanResetReport> {
  const profilesTrashCleared = await clearProfilesTrash();
  const sopCacheCleared = await clearSopCache();
  const removedTools = await removeAllToolRules();
  const capabilityRefsCleared = await clearCapabilityRefs();
  const purged = purgeAllSoftDeleted(db);
  await auditLog
    .logOrphanCleanup({
      action: 'clean_reset',
      emptySince,
      profilesTrashCleared,
      sopCacheCleared,
      removedTools,
      capabilityRefsCleared,
      purged,
    })
    .catch(() => {});
  return {
    emptySince,
    profilesTrashCleared,
    sopCacheCleared,
    removedTools,
    capabilityRefsCleared,
    purged,
  };
}

async function clearProfilesTrash(): Promise<boolean> {
  try {
    await fs.promises.rm(path.join(PROFILES_DIR, 'trash'), { recursive: true, force: true });
    return true;
  } catch (err) {
    warn('[orphan-reconcile] 全局重置：清理画像 trash 失败:', err);
    return false;
  }
}

async function clearSopCache(): Promise<boolean> {
  try {
    await sopCache.clearCache();
    return true;
  } catch (err) {
    warn('[orphan-reconcile] 全局重置：清空 SOP 缓存失败:', err);
    return false;
  }
}

async function removeAllToolRules(): Promise<string[]> {
  const removedTools: string[] = [];
  try {
    const toolIds = wisdomBrainSync.getRuleSync().getUnfilteredToolIds();
    for (const toolId of toolIds) {
      try {
        await wisdomBrainSync.getRuleSync().removeRules(toolId);
        removedTools.push(toolId);
      } catch (err) {
        warn(`[orphan-reconcile] 全局重置：删除工具规则 ${toolId} 失败:`, err);
      }
    }
  } catch (err) {
    warn('[orphan-reconcile] 全局重置：工具规则清除失败:', err);
  }
  return removedTools;
}

async function clearCapabilityRefs(): Promise<boolean> {
  try {
    await saveCapabilityRefs({ schemaVersion: 1, capabilities: {} });
    return true;
  } catch (err) {
    warn('[orphan-reconcile] 全局重置：清空能力账本失败:', err);
    return false;
  }
}

function purgeAllSoftDeleted(db: ReturnType<typeof getDb>): { table: string; deleted: number }[] {
  try {
    return purgeExpiredSoftDeleted(db, 0);
  } catch (err) {
    warn('[orphan-reconcile] 全局重置：DB 软删行强清失败:', err);
    return [];
  }
}

/**
 * 空项目集宽限逻辑：空集开始记录 → 7 天到期执行全局重置（项目重加则取消宽限）。
 * 置于画像扫描/TTL 之后：重置为最后一个写操作，避免扫描新移入的残留被跳过。
 */
async function handleEmptyGrace(
  db: ReturnType<typeof getDb>,
  activeProjectPaths: string[],
  state: OrphanState,
): Promise<CleanResetReport | undefined> {
  if (activeProjectPaths.length > 0) {
    delete state[EMPTY_SINCE_KEY];
    return undefined;
  }
  const existing = state[EMPTY_SINCE_KEY];
  if (typeof existing !== 'number') {
    if (await hasLocalResiduals(db)) {
      state[EMPTY_SINCE_KEY] = Date.now();
      console.warn('[orphan-reconcile] 项目集为空且存在残留 → 开始 7 天宽限记录');
    }
    return undefined;
  }
  if (Date.now() - existing < EMPTY_GRACE_MS) return undefined;
  const report = await resetToCleanState(db, existing);
  delete state[EMPTY_SINCE_KEY];
  return report;
}

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
function computeOrphanCandidates(
  db: ReturnType<typeof getDb>,
  activeProjectPaths: string[],
): string[] {
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
  db: ReturnType<typeof getDb>;
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
  db: ReturnType<typeof getDb>,
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
  db: ReturnType<typeof getDb>,
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
  db: ReturnType<typeof getDb>,
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
async function runTtlPurge(
  db: ReturnType<typeof getDb>,
): Promise<{ table: string; deleted: number }[]> {
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
