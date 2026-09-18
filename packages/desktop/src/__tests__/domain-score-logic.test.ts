import { describe, expect, it } from 'vitest';
import { domainScoreView, findDimension } from '../pages/domain-score-logic';

const NOW = Date.parse('2026-09-19T12:00:00+08:00');

describe('domain-score-logic', () => {
  it('无汇总数据 → no-data，占位符 —，绝不显示 0 分', () => {
    const v = domainScoreView(undefined, undefined, NOW);
    expect(v.kind).toBe('no-data');
    expect(v.scoreText).toBe('—');
  });

  it('汇总里没有该维度条目 → 同样按 no-data 兜底', () => {
    const v = domainScoreView(undefined, '2026-09-19T10:00:00+08:00', NOW);
    expect(v.kind).toBe('no-data');
  });

  it('维度 not-run → 未检测，占位符 —，不按 0 分上色', () => {
    const v = domainScoreView({ score: 0, status: 'not-run' }, '2026-09-19T10:00:00+08:00', NOW);
    expect(v.kind).toBe('not-run');
    expect(v.scoreText).toBe('—');
  });

  it('已评分且新鲜 → scored，分数如实展示', () => {
    const v = domainScoreView({ score: 88, status: 'scored' }, '2026-09-19T10:00:00+08:00', NOW);
    expect(v.kind).toBe('scored');
    expect(v.scoreText).toBe('88');
    expect(v.ageHours).toBe(2);
  });

  it('缺 status 的旧记录按已评分兼容（与 dimensionView 口径一致）', () => {
    const v = domainScoreView({ score: 70 }, '2026-09-19T11:30:00+08:00', NOW);
    expect(v.kind).toBe('scored');
    expect(v.scoreText).toBe('70');
  });

  it('超过 24h → stale，分数仍展示但标注陈旧', () => {
    const v = domainScoreView({ score: 92, status: 'scored' }, '2026-09-18T00:00:00+08:00', NOW);
    expect(v.kind).toBe('stale');
    expect(v.scoreText).toBe('92');
    expect(v.ageHours).toBe(36);
  });

  it('真 0 分（已检测）如实显示 0，不被吞并', () => {
    const v = domainScoreView({ score: 0, status: 'scored' }, '2026-09-19T10:00:00+08:00', NOW);
    expect(v.kind).toBe('scored');
    expect(v.scoreText).toBe('0');
  });

  it('findDimension 按名字取维度；无数据返回 undefined', () => {
    const data = {
      dimensions: [
        { name: 'quality', score: 90, status: 'scored' as const },
        { name: 'gate', score: 0, status: 'not-run' as const },
      ],
    };
    expect(findDimension(data, 'quality')?.score).toBe(90);
    expect(findDimension(data, 'gate')?.status).toBe('not-run');
    expect(findDimension(null, 'security')).toBeUndefined();
    expect(findDimension(data, 'performance')).toBeUndefined();
  });
});
