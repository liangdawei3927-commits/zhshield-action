/**
 * 哨兵健康取数（十域评分章程 #9）——**以 DB 为准**。
 *
 * 背景（2026-10-24 修复）：原先评分取数走 `EventCenter.listEvents()`，那是**内存 Map**，
 * 库里落盘的几百条事件一条也读不到 ⇒ `warningEvents` 恒 0 ⇒ 哨兵域恒 100 分
 * （实测 12 条评分里 11 条 100 分，而库里本项目有 288 条事件、其中 p2 39 条）。
 * 内存态只在本次进程产生的事件里有效，重启即空 —— 用它做评分等于把「有没有扫过」
 * 当成了「有没有问题」。
 *
 * 故取数落回 DB：事件产生时同步落盘（`EventCenter.persistEvent`），DB 才是全量事实。
 *
 * 与 ipc/sentinel.ts 的边界：本文件**不 import electron / ipcMain**，纯 DB 逻辑，
 * 便于直接单测；IPC 层只负责取到 db 实例并做降级。
 */

import { countSentinelEventsBySeverity, type DbConnection } from '@zh/db';

// desktop 包不直接依赖 better-sqlite3（只有 @zh/db 依赖），句柄类型从连接类推导
export type SentinelDbHandle = ReturnType<DbConnection['connect']>;

/** 终态事件：已处理完的告警不再计入扣分（对应原内存实现的过滤条件） */
export const TERMINAL_EVENT_STATUSES: readonly string[] = ['passed', 'merged', 'deployed'];

export interface SentinelHealthCounts {
  /** 是否正在监控（由调用方传入：主进程持有该状态） */
  active: boolean;
  criticalEvents: number;
  warningEvents: number;
  /** 计入的事件总数（未软删、非终态） */
  total: number;
}

/**
 * 从 DB 读某项目的哨兵健康计数。
 *
 * 返回 `null` = 该项目既没在监控、也从未产生事件 ⇒ 评分侧按 not-run 处理
 * （不参与加权，而不是按满分算）。
 */
export function readSentinelHealthFromDb(
  db: SentinelDbHandle,
  projectId: string,
  options: { monitoring: boolean },
): SentinelHealthCounts | null {
  const counts = countSentinelEventsBySeverity(db, projectId, {
    excludeStatuses: TERMINAL_EVENT_STATUSES,
  });
  const active = options.monitoring;
  if (!active && counts.total === 0) return null;
  return {
    active,
    criticalEvents: counts.p1,
    warningEvents: counts.p2,
    total: counts.total,
  };
}
