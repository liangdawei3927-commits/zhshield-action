import { describe, expect, it } from 'vitest';
import { t } from '@zh/i18n';
import { domainScoreView, findDimension, pickDomainScore } from '../pages/domain-score-logic';

const NOW = Date.parse('2026-09-19T12:00:00+08:00');

describe('domain-score-logic', () => {
  it('无汇总数据 → no-data，占位符 —，绝不显示 0 分', () => {
    const v = domainScoreView({ dim: undefined, generatedAt: undefined, now: NOW });
    expect(v.kind).toBe('no-data');
    expect(v.scoreText).toBe('—');
  });

  it('汇总里没有该维度条目 → 同样按 no-data 兜底', () => {
    const v = domainScoreView({ dim: undefined, generatedAt: '2026-09-19T10:00:00+08:00', now: NOW });
    expect(v.kind).toBe('no-data');
  });

  it('维度 not-run → 未检测，占位符 —，不按 0 分上色', () => {
    const v = domainScoreView({
      dim: { score: 0, status: 'not-run' },
      generatedAt: '2026-09-19T10:00:00+08:00',
      now: NOW,
    });
    expect(v.kind).toBe('not-run');
    expect(v.scoreText).toBe('—');
  });

  it('已评分且新鲜 → scored，分数如实展示', () => {
    const v = domainScoreView({
      dim: { score: 88, status: 'scored' },
      generatedAt: '2026-09-19T10:00:00+08:00',
      now: NOW,
    });
    expect(v.kind).toBe('scored');
    expect(v.scoreText).toBe('88');
    expect(v.ageHours).toBe(2);
  });

  it('缺 status 的旧记录按已评分兼容（与 dimensionView 口径一致）', () => {
    const v = domainScoreView({
      dim: { score: 70 },
      generatedAt: '2026-09-19T11:30:00+08:00',
      now: NOW,
    });
    expect(v.kind).toBe('scored');
    expect(v.scoreText).toBe('70');
  });

  it('超过 24h → stale，分数仍展示但标注陈旧', () => {
    const v = domainScoreView({
      dim: { score: 92, status: 'scored' },
      generatedAt: '2026-09-18T00:00:00+08:00',
      now: NOW,
    });
    expect(v.kind).toBe('stale');
    expect(v.scoreText).toBe('92');
    expect(v.ageHours).toBe(36);
  });

  it('真 0 分（已检测）如实显示 0，不被吞并', () => {
    const v = domainScoreView({
      dim: { score: 0, status: 'scored' },
      generatedAt: '2026-09-19T10:00:00+08:00',
      now: NOW,
    });
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

describe('pickDomainScore（实时快照优先，回退汇总）', () => {
  const summary = {
    dimensions: [{ name: 'quality', score: 90, status: 'scored' as const }],
    timestamp: '2026-09-19T08:00:00+08:00',
  };

  it('live 已评分 → 用 live（本次检查当场出分），时间戳取快照生成时间', () => {
    const picked = pickDomainScore(
      { score: 88, issues: 2, status: 'scored', generatedAt: '2026-09-19T12:00:00+08:00' },
      summary,
      'quality',
    );
    expect(picked.dim?.score).toBe(88);
    expect(picked.generatedAt).toBe('2026-09-19T12:00:00+08:00');
  });

  it('live 缺失（null）→ 回退汇总对应维度', () => {
    const picked = pickDomainScore(null, summary, 'quality');
    expect(picked.dim?.score).toBe(90);
    expect(picked.generatedAt).toBe(summary.timestamp);
  });

  it('live 为旧格式快照（status 非 scored 视为无分）→ 回退汇总', () => {
    const picked = pickDomainScore(
      { score: 0, status: 'not-run', generatedAt: '2026-09-19T12:00:00+08:00' },
      summary,
      'quality',
    );
    expect(picked.dim?.score).toBe(90);
  });

  it('两者皆无 → dim undefined，由 domainScoreView 兜底 no-data', () => {
    const picked = pickDomainScore(null, null, 'quality');
    expect(picked.dim).toBeUndefined();
    const v = domainScoreView({ dim: picked.dim, generatedAt: picked.generatedAt });
    expect(v.kind).toBe('no-data');
    expect(v.scoreText).toBe('—');
  });

  it('live 带 previousScore → 透传给视图（上次 → 本次对比）', () => {
    const picked = pickDomainScore(
      {
        score: 91,
        status: 'scored',
        generatedAt: '2026-09-19T12:00:00+08:00',
        previousScore: { score: 82, generatedAt: '2026-09-18T12:00:00+08:00' },
      },
      summary,
      'quality',
    );
    expect(picked.previousScore).toBe(82);
    const v = domainScoreView({
      dim: picked.dim,
      generatedAt: picked.generatedAt,
      now: Date.now(),
      tr: t,
      previousScore: picked.previousScore,
    });
    expect(v.kind).toBe('scored');
    expect(v.previousScore).toBe(82);
  });

  it('live 无 previousScore（旧格式）→ 视图不带对比字段', () => {
    const picked = pickDomainScore(
      { score: 88, status: 'scored', generatedAt: '2026-09-19T12:00:00+08:00' },
      summary,
      'quality',
    );
    expect(picked.previousScore).toBeUndefined();
    const v = domainScoreView({ dim: picked.dim, generatedAt: picked.generatedAt });
    expect(v.previousScore).toBeUndefined();
  });
});
