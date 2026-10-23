import { describe, expect, it } from 'vitest';
import { buildHistoryRows, deltaDirection } from '../pages/domain-history-logic';
import type { DomainScanRecordData } from '../types/electron';

/**
 * 历史记录的展示层 diff。
 *
 * 三条硬约束：
 * 1. 首次扫描不编造涨跌（scoreDelta = null）；
 * 2. 任一侧无分数（该域不出分）也不当 0；
 * 3. 新增 / 修复按指纹集合算，不按「问题数之差」算 —— 一增一减会让总数不变，
 *    但实际是「修掉 3 条又新进 3 条」，只看总数会误判为「毫无变化」。
 */

function record(
  scannedAt: string,
  fingerprints: string[],
  score: number | null,
  extra: Partial<DomainScanRecordData> = {},
): DomainScanRecordData {
  return {
    scanId: scannedAt,
    domain: 'inspect',
    scannedAt,
    recordedAt: scannedAt,
    score,
    total: fingerprints.length,
    error: 0,
    warning: fingerprints.length,
    info: 0,
    fingerprints,
    fingerprintsHash: scannedAt,
    ...extra,
  };
}

describe('buildHistoryRows', () => {
  it('新→旧数组：与更早一条比较，算出新增 / 修复 / 遗留', () => {
    const rows = buildHistoryRows([
      record('2026-10-24T02:00:00.000Z', ['b', 'c'], 85),
      record('2026-10-24T01:00:00.000Z', ['a', 'b'], 90),
    ]);
    expect(rows[0].added).toBe(1);
    expect(rows[0].removed).toBe(1);
    expect(rows[0].persisting).toBe(1);
    expect(rows[0].scoreDelta).toBe(-5);
    expect(rows[0].totalDelta).toBe(0);
  });

  it('最早一条没有基线：变化记 0，scoreDelta 为 null', () => {
    const rows = buildHistoryRows([record('2026-10-24T01:00:00.000Z', ['a'], 90)]);
    expect(rows[0].added).toBe(0);
    expect(rows[0].removed).toBe(0);
    expect(rows[0].persisting).toBe(1);
    expect(rows[0].scoreDelta).toBeNull();
  });

  it('总数不变但内容是换了：仍能看出「修 3 条 + 新进 3 条」', () => {
    const rows = buildHistoryRows([
      record('2026-10-24T02:00:00.000Z', ['d', 'e', 'f'], 80),
      record('2026-10-24T01:00:00.000Z', ['a', 'b', 'c'], 80),
    ]);
    expect(rows[0].totalDelta).toBe(0);
    expect(rows[0].added).toBe(3);
    expect(rows[0].removed).toBe(3);
  });

  it('该域不出分（null）→ scoreDelta 为 null，不当 0', () => {
    const rows = buildHistoryRows([
      record('2026-10-24T02:00:00.000Z', ['a'], null),
      record('2026-10-24T01:00:00.000Z', ['a'], null),
    ]);
    expect(rows[0].scoreDelta).toBeNull();
    expect(rows[0].persisting).toBe(1);
  });
});

describe('deltaDirection', () => {
  it('涨 → up，跌 → down，持平 / 无基线 → flat', () => {
    expect(deltaDirection(2.5)).toBe('up');
    expect(deltaDirection(-0.1)).toBe('down');
    expect(deltaDirection(0)).toBe('flat');
    expect(deltaDirection(null)).toBe('flat');
  });
});
