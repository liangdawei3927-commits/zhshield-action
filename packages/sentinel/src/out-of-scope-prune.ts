/**
 * 失效事件收敛（out-of-scope-prune.ts）——「修好生成端」之后必须补的一半。
 *
 * 背景（2026-10-25 实机）：file-monitor 把 `build-output/`、`.app` 等产物路径
 * 纳入监控，一次 electron-builder 重建炸出 270 条 p2 unlink。生成端修好后
 * **新事件确实归零**，但库里那 270 条旧事件仍是 `deleted_at IS NULL`，
 * 而 `listSentinelEvents` 只过滤软删标记 —— 页面与「复制到AI」永远显示
 * 同样 270 条，用户看到的是「修了也没用」。
 *
 * 收敛判据（不是按时间删、也不是按条数删）——**事件描述的状态是否还成立**：
 *   A. 路径按当前监控口径已越界 ⇒ 这条事件本就不该存在（忽略规则收紧的遗留）；
 *   B. `unlink` 事件的**目标仍回到磁盘** ⇒ 删除没落地（报告重新生成、git 恢复），
 *      这条「文件被删了」的告警已经不成立；
 *   C. `unlink` 事件的目标**至今仍未回盘**、且该路径**从不属于交付物**（不在 git 索引），
 *      并已过保留窗口 ⇒ 这是临时文件/探针脚本的正常生命周期。
 *
 * 判据 C 补的是判据 B 的反面：B 只处理「删除没落地」，而对「删除确实落地了、
 * 删的又只是临时文件」这类事件，条件永远不成立 ⇒ 它们会永久停在 LIVE。
 * 2026-10-25 实测：外层项目 18 条 p2 `File unlink`（`.probe.cjs`、`tmp-preview.tsx`、
 * `verify-fix.mjs` …）全部是未跟踪文件，`git status` 里 ` D` 计数为 0，
 * 却因为没有判据 C 而永远挂在告警列表上。
 *
 * 三条都复用产品既有口径（`isIgnoredPath` / 文件系统实际状态 / `git-index`），
 * 不另立规则。只软删（打 `deleted_at`），可逆、可审计；`purgeExpiredSoftDeleted` 按 TTL 收尾。
 */

import * as fs from 'fs';
import type Database from 'better-sqlite3';
import { listSentinelEvents, softDeleteSentinelEvents } from '@zh/db';
import { isIgnoredPath } from './file-monitor';
import { GitIndexCache } from './git-index';

/** 只有文件级事件带 filePath；其余模块原样保留 */
export const PRUNABLE_MODULE = 'file-monitor';

/**
 * 判据 C 的保留窗口：删除已既定、且删的不是交付物，超过该窗口仍无人处理即视为噪音。
 *
 * 取 12 小时而不是「删完即收敛」：同一次工作会话内删掉的临时文件仍要能被审计到，
 * 否则代理工具正在跑的时候事件会边报边消失。取 12 而不是 24：未跟踪文件的删除
 * 本身没有任何可执行动作（没有东西能恢复、没有东西要复核），留满一天只会让
 * 「18 条 p2」这种积压多挂一夜。
 */
export const DEFAULT_UNLINK_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * 单次扫描上限。活事件表实测 985 行（含软删共 3.8 万行），
 * 上限给足避免「扫一半就停」这种静默截断。
 */
export const PRUNE_SCAN_LIMIT = 20_000;

/** 收敛所需的最小行形状（便于用假数据单测，不必建库） */
export interface PrunableEventLike {
  id: string;
  module: string;
  /** DB 里是 JSON 字符串，内存里是对象 —— 两种形态都要吃 */
  context: unknown;
  /** 事件发生时间（ISO 字符串，DB 原样）；判据 C 用它算保留窗口，缺省则不参与判据 C */
  timestamp?: string;
}

/** 事件 context 里与收敛相关的字段 */
interface EventContextView {
  filePath?: string;
  changeType?: string;
}

/** 解析 context；损坏 JSON / 非对象返回 null（跳过，不误删） */
function parseEventContext(context: unknown): EventContextView | null {
  let parsed: unknown = context;
  if (typeof context === 'string') {
    try {
      parsed = JSON.parse(context);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  return parsed as EventContextView;
}

/** 从事件 context 中取文件绝对路径；取不到返回 null */
export function readEventFilePath(context: unknown): string | null {
  const view = parseEventContext(context);
  const filePath = view?.filePath;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null;
}

/** 收敛判据的可注入依赖（单测不碰真实文件系统 / 不跑 git） */
export interface PruneCriteria {
  ignoreDirs?: readonly string[];
  /** 目标是否存在；默认 fs.existsSync */
  fileExists?: (filePath: string) => boolean;
  /**
   * 交付物判定（判据 C 的依据）：true = 在索引里，false = 未跟踪，null = 不可判定。
   *
   * 为什么是「按路径的函数」而不是「项目的索引集合」：监控根与仓库边界不一定
   * 重合（外层文档仓库里嵌着内层代码仓库）。用单一集合判定的话，内层已跟踪的
   * 源文件会被全部判成未跟踪 ⇒ 判据 C 会把「真实源文件被删」的告警自动软删，
   * 属假阴性。判定必须按目标路径各自找仓库（见 `git-index.ts`）。
   *
   * 未提供 = 不可判定 ⇒ 判据 C 不生效（保留事件），绝不因读不到索引而误删。
   */
  isTracked?: (fullPath: string) => boolean | null;
  /** 判据 C 的「现在」（毫秒），便于单测注入 */
  now?: number;
  /** 判据 C 的保留窗口，默认 {@link DEFAULT_UNLINK_TTL_MS} */
  unlinkTtlMs?: number;
}

/**
 * 判据 C：unlink 的目标至今未回盘、路径不属交付物、且已过保留窗口。
 *
 * 三个条件缺一不可：
 *  - 索引可判定（`isTracked` 已提供且返回非 null）；读不到 git 就不下结论；
 *  - 该路径不在**其所属仓库**的索引里（含目录形态：其下也没有被跟踪的文件）；
 *  - 事件足够老 —— 刚删的临时文件仍要能被看到。
 */
function isObsoleteUntrackedUnlink(
  row: PrunableEventLike,
  filePath: string,
  criteria: PruneCriteria,
): boolean {
  const resolve = criteria.isTracked;
  if (!resolve) return false;
  if (typeof row.timestamp !== 'string') return false;
  const age = (criteria.now ?? Date.now()) - Date.parse(row.timestamp);
  if (!Number.isFinite(age)) return false;
  if (age < (criteria.unlinkTtlMs ?? DEFAULT_UNLINK_TTL_MS)) return false;
  return resolve(filePath) === false;
}

/** 该事件是否已失效（越界 或 删除已不成立 或 删的只是未跟踪临时文件） */
function isStaleEvent(
  row: PrunableEventLike,
  view: EventContextView,
  projectPath: string,
  criteria: PruneCriteria,
): boolean {
  const { filePath } = view;
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  if (isIgnoredPath(filePath, projectPath, criteria.ignoreDirs)) return true;
  if (view.changeType !== 'unlink') return false;
  const exists = criteria.fileExists ?? fs.existsSync;
  if (exists(filePath)) return true;
  return isObsoleteUntrackedUnlink(row, filePath, criteria);
}

/**
 * 挑出已失效的事件 id。
 *
 * 看不到 filePath 的事件一律不动：宁可留噪音，不可误删真事件。
 */
export function collectStaleEventIds(
  rows: readonly PrunableEventLike[],
  projectPath: string,
  criteria: PruneCriteria = {},
): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.module !== PRUNABLE_MODULE) continue;
    const view = parseEventContext(row.context);
    if (view === null) continue;
    if (isStaleEvent(row, view, projectPath, criteria)) ids.push(row.id);
  }
  return ids;
}

/**
 * 扫库并把失效历史事件软删，返回实际软删条数。
 *
 * 读库失败/写库失败由调用方兜（收敛是维护动作，绝不能拖垮监控启动）。
 * 未显式给 `isTracked` 时才建一个判定器 —— 它按仓库根缓存索引，
 * 一次扫描里每个嵌套仓库最多 spawn 一次 git，不是每行一次。
 */
export async function pruneStaleFileEvents(
  db: Database.Database,
  projectPath: string,
  options?: PruneCriteria & { limit?: number },
): Promise<number> {
  const rows = listSentinelEvents(db, {
    projectId: projectPath,
    limit: options?.limit ?? PRUNE_SCAN_LIMIT,
  });
  const isTracked = options?.isTracked ?? defaultTrackedResolver();
  const ids = collectStaleEventIds(rows as readonly PrunableEventLike[], projectPath, {
    ...options,
    isTracked,
  });
  return softDeleteSentinelEvents(db, ids);
}

/** 生产用判定器：仓库根按目录缓存、索引按仓库缓存 */
function defaultTrackedResolver(): (fullPath: string) => boolean | null {
  const cache = new GitIndexCache();
  return (fullPath) => cache.isTrackedSync(fullPath);
}
