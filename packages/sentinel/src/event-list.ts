/**
 * 事件取数：DB 行 → 领域对象、以及「DB + 内存」合并列表。
 *
 * 为什么从 `EventCenter` 抽出来（2026-10-25）：
 * 1. 该取数逻辑本身是纯函数，挂在有状态的类上只让类变大 —— 实测把它塞进
 *    `EventCenter` 后类体 326 行，撞上门禁 `large-class` 300 行硬阈值，提交被阻断；
 * 2. 抽成独立模块后可直接单测，不必构造 EventCenter、不必启动监控。
 *
 * 合并语义见 `listMergedEvents`。
 */

import type Database from 'better-sqlite3';
import type { SentinelEventRow } from '@zh/db';
import { listSentinelEvents } from '@zh/db';
import type { SentinelEvent, EventStatus, EventSeverity } from './types';

/**
 * 一次最多返回多少条（合并后）。
 *
 * 事件是长期累积的（本项目实测未软删 338 条、含软删共 3.8 万行），
 * 无上限回填会让哨兵页越用越慢。500 覆盖单项目正常观察窗口。
 */
export const LIST_EVENTS_LIMIT = 500;

/** 事件查询筛选条件（与 IPC `SentinelEventQuery` 的 status/severity 同义） */
export interface EventFilters {
  /** 只返回该项目的事件。**必须由调用方传入**：事件表是多项目共用的，
   * 缺省 = 跨项目全量返回 —— 曾因此让哨兵页把别的项目的待处理事件
   * 显示在当前项目名下，而评分卡按项目算分，出现「3 个问题却 100 分」的口径分裂
   * （2026-10-26 实测修复）。 */
  projectId?: string;
  status?: EventStatus;
  severity?: EventSeverity;
}

/**
 * DB 行 → 领域对象。
 *
 * validation / context / history 在库里是 JSON 字符串，必须还原成对象，
 * 否则渲染层拿到的会是字符串（历史数组判空、处置结果展示都会错）。
 */
export function rowToEvent(row: SentinelEventRow): SentinelEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    timestamp: new Date(row.timestamp),
    dedupeKey: row.dedupe_key,
    title: row.title,
    service: row.service,
    module: row.module,
    severity: row.severity as EventSeverity,
    status: row.status as EventStatus,
    validation: typeof row.validation === 'string' ? JSON.parse(row.validation) : row.validation,
    context: typeof row.context === 'string' ? JSON.parse(row.context) : row.context,
    history: typeof row.history === 'string' ? JSON.parse(row.history) : row.history,
    occurrenceCount: row.occurrence_count,
    firstSeen: new Date(row.first_seen),
    lastSeen: new Date(row.last_seen),
  };
}

/**
 * 合并 DB 与内存事件，按时间倒序返回（**DB 为准，内存覆盖同 id**）。
 *
 * 为什么必须读 DB：内存 Map 只活一个进程。主进程重启、或用户关掉窗口再打开，
 * 内存清空 ⇒ 哨兵页事件列表空白 ⇒ 详情入口消失，用户看到的是「从未监控过」。
 * 而库里躺着几百条真实事件（实测 338 条），原先一条也读不到。
 *
 * 为什么内存要覆盖：本次进程可能已经把某条事件流转到 passed / 补充了处置历史，
 * 这些变更落后于 DB 行时不能让 DB 盖回去（persistUpdate 是异步兜底，不保证时序）。
 *
 * 读库失败不连累内存态：本次进程产生的事件仍然要能显示。
 */
export function listMergedEvents(
  db: Database.Database | null,
  memory: ReadonlyMap<string, SentinelEvent>,
  filters?: EventFilters,
): SentinelEvent[] {
  const merged = new Map<string, SentinelEvent>();
  if (db) {
    try {
      // projectId 必须下推到 SQL：全表拉回再内存过滤会在事件量大的库上白拉几万行
      for (const row of listSentinelEvents(db, {
        limit: LIST_EVENTS_LIMIT,
        projectId: filters?.projectId,
      })) {
        merged.set(row.id, rowToEvent(row));
      }
    } catch (err) {
      console.error('[EventCenter] Failed to list events from DB:', err);
    }
  }
  for (const [id, event] of memory) {
    if (filters?.projectId && event.projectId !== filters.projectId) continue;
    merged.set(id, event);
  }

  let results = [...merged.values()];
  if (filters?.projectId) results = results.filter((e) => e.projectId === filters.projectId);
  if (filters?.status) results = results.filter((e) => e.status === filters.status);
  if (filters?.severity) results = results.filter((e) => e.severity === filters.severity);
  return results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}
