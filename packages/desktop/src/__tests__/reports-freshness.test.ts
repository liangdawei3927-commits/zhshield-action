import { describe, it, expect } from 'vitest';
import { SCORE_FRESH_MS, scoreFreshness } from '../pages/reports-logic';

/**
 * 总分新鲜度判定（T14 落分口径统一）
 *
 * 总分是「上一次检查结果的汇总」，不是实时值。落分点的数量是固定的两个
 * （pipeline 跑完 recordPipelineScore / 报告中心 generateReportSummary），
 * 二者共用 buildHealthDimensions + ScoringEngine.calculate。因此 UI 必须显式
 * 标注这份分有多旧，否则用户会把陈旧分当成当前状态。
 */
describe('scoreFreshness', () => {
  const NOW = Date.parse('2026-09-18T12:00:00.000Z');

  it('阈值为 24h（全仓唯一来源；主进程侧的六卡阈值已随死链路删除）', () => {
    expect(SCORE_FRESH_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('刚写入的分数为新鲜', () => {
    const r = scoreFreshness(new Date(NOW).toISOString(), NOW);
    expect(r.stale).toBe(false);
    expect(r.ageHours).toBe(0);
  });

  it('恰好 24h 内仍算新鲜，超过即判陈旧', () => {
    const within = new Date(NOW - SCORE_FRESH_MS + 60_000).toISOString();
    expect(scoreFreshness(within, NOW).stale).toBe(false);

    const beyond = new Date(NOW - SCORE_FRESH_MS - 60_000).toISOString();
    expect(scoreFreshness(beyond, NOW).stale).toBe(true);
  });

  it('陈旧时给出整数小时数', () => {
    const r = scoreFreshness(new Date(NOW - 50 * 3_600_000).toISOString(), NOW);
    expect(r.stale).toBe(true);
    expect(r.ageHours).toBe(50);
  });

  it('时间戳不可解析时判陈旧且不抛错（宁可提示，不可沉默）', () => {
    const r = scoreFreshness('not-a-date', NOW);
    expect(r.stale).toBe(true);
    expect(r.ageHours).toBe(0);
  });

  it('未来时间戳不会产生负龄（时钟回拨保护）', () => {
    const r = scoreFreshness(new Date(NOW + 3_600_000).toISOString(), NOW);
    expect(r.ageHours).toBe(0);
    expect(r.stale).toBe(false);
  });
});
