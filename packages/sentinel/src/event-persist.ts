/**
 * 事件落库：内存态 → `sentinel_events` 表。
 *
 * 与 `event-list.ts`（读）成对，构成事件的数据层。从 `EventCenter` 抽出的原因：
 * 该类体已到门禁 `large-class` 300 行阈值边缘，而这部分逻辑只依赖 db 句柄与事件对象，
 * 无状态、可单独验证；留在类里既撑大文件，也让「写失败只打日志」这种兜底更难被发现。
 */

import type Database from 'better-sqlite3';
import { createSentinelEvent, updateSentinelEvent } from '@zh/db';
import type { SentinelEvent } from './types';

/**
 * 新建事件落库。
 *
 * 失败只打日志、不抛出：事件已经进了内存 Map，监控链路不该因为一次落库失败而中断
 * ——但这也意味着「DB 是事实来源」需要在读侧兜底（见 `listMergedEvents`）。
 */
export function persistNewEvent(db: Database.Database | null, event: SentinelEvent): void {
  if (!db) return;
  try {
    createSentinelEvent(db, {
      id: event.id,
      projectId: event.projectId,
      timestamp: event.timestamp,
      dedupeKey: event.dedupeKey,
      title: event.title,
      service: event.service,
      module: event.module,
      severity: event.severity,
      status: event.status,
      validation: JSON.stringify(event.validation),
      context: JSON.stringify(event.context),
      history: JSON.stringify(event.history),
      occurrenceCount: event.occurrenceCount,
      firstSeen: event.firstSeen,
      lastSeen: event.lastSeen,
    });
  } catch (err) {
    console.error('[EventCenter] Failed to persist event:', err);
  }
}

/** 状态/验证结果/历史变更落库（同上，失败只打日志） */
export function persistEventUpdate(db: Database.Database | null, event: SentinelEvent): void {
  if (!db) return;
  try {
    updateSentinelEvent(db, {
      id: event.id,
      status: event.status,
      validation: JSON.stringify(event.validation),
      history: JSON.stringify(event.history),
      occurrenceCount: event.occurrenceCount,
      lastSeen: event.lastSeen,
    });
  } catch (err) {
    console.error('[EventCenter] Failed to persist update:', err);
  }
}
