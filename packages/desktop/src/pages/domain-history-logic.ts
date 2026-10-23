/**
 * 历史记录展示层纯逻辑（无 React、无 IO，便于单测）。
 *
 * 为什么放在渲染层重算 diff、而不是主进程存好：
 * 指纹集本来就随每条记录落盘，diff 是一次集合运算（几百条量级），
 * 放在展示层算的好处是「改对比口径不需要重写历史文件」。
 * 主进程只在需要跨设备/跨版本对比时才需要持久化 diff 结果。
 */

import type { DomainScanRecordData } from '../types/electron';

/** 一行历史记录 + 相对「上一次」的变化 */
export interface HistoryRow {
  record: DomainScanRecordData;
  /** 本次新增的问题（上一条没有、这条有） */
  added: number;
  /** 本次修复的问题（上一条有、这条没有） */
  removed: number;
  /** 仍然存在的问题数 */
  persisting: number;
  /** 分数变化；任一侧无分数（该域不出分）→ null，不当作 0 处理 */
  scoreDelta: number | null;
  /** 问题总数变化 */
  totalDelta: number;
}

/**
 * 把「新→旧」的记录数组转成带变化的行。
 *
 * 最后一条（最早的一次）没有更早的记录可比 → added/removed 记 0，
 * scoreDelta 为 null —— 首次扫描不编造涨跌。
 */
export function buildHistoryRows(
  records: readonly DomainScanRecordData[],
): HistoryRow[] {
  return records.map((record, index) => {
    const previous = records[index + 1] ?? null;
    if (!previous) {
      return {
        record,
        added: 0,
        removed: 0,
        persisting: record.fingerprints.length,
        scoreDelta: null,
        totalDelta: 0,
      };
    }
    const current = new Set(record.fingerprints);
    const before = new Set(previous.fingerprints);
    let added = 0;
    let persisting = 0;
    for (const fingerprint of current) {
      if (before.has(fingerprint)) persisting += 1;
      else added += 1;
    }
    let removed = 0;
    for (const fingerprint of before) {
      if (!current.has(fingerprint)) removed += 1;
    }
    const scoreDelta =
      record.score !== null && previous.score !== null
        ? Math.round((record.score - previous.score) * 10) / 10
        : null;
    return {
      record,
      added,
      removed,
      persisting,
      scoreDelta,
      totalDelta: record.total - previous.total,
    };
  });
}

/** 变化方向（用于配色）：up=分数涨、down=跌、flat=持平/无基线 */
export function deltaDirection(delta: number | null): 'up' | 'down' | 'flat' {
  if (delta === null || delta === 0) return 'flat';
  return delta > 0 ? 'up' : 'down';
}
