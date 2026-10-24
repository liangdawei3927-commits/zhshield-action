/**
 * computeOverallSnapshot：只读总评（2026-10-24 新增）
 *
 * 为什么需要它：报告中心总览与分类页要显示「当下」的分，但 `ScoringEngine.calculate`
 * 一调用就往 scores 表插一条 —— 用 calculate 出实时分，等于把「打开页面」当成一次
 * 评估，历史曲线会被浏览行为污染（实测：history 里混着扫描记录与补记记录）。
 *
 * 本测试锁的是「它与 calculate 同一套规则」：加权、not-run 不参与、红线封顶、分级
 * 必须逐项对齐，否则「总分 ≠ 十张卡加权」会换个地方复发。
 */
import { describe, it, expect } from 'vitest';
import { computeOverallSnapshot } from '../engine';
import { ScoringEngine } from '../engine';
import type { DimensionScore } from '../types';

const dim = (
  name: string,
  score: number,
  weight: number,
  status?: 'scored' | 'not-run',
): DimensionScore => ({ name, score, weight, issues: 0, ...(status ? { status } : {}) });

describe('computeOverallSnapshot', () => {
  it('加权总评：与 ScoringEngine.calculate 同一结果', () => {
    const dimensions = [dim('quality', 90, 0.4), dim('security', 80, 0.6)];
    const snapshot = computeOverallSnapshot(dimensions);
    const engine = new ScoringEngine();
    const calculated = engine.calculate('p-same', dimensions.map((d) => ({ ...d })));
    expect(snapshot.overall).toBeCloseTo(calculated.overall, 2);
    expect(snapshot.grade).toBe(calculated.grade);
  });

  it('not-run 维度不参与加权（未检测 ≠ 满分，也不当 0 分）', () => {
    const snapshot = computeOverallSnapshot([
      dim('quality', 90, 0.5),
      dim('gate', 0, 0.5, 'not-run'),
    ]);
    expect(snapshot.overall).toBe(90);
  });

  it('红线封顶：capped 时总评被压制到 cap', () => {
    const snapshot = computeOverallSnapshot([dim('quality', 95, 1)], {
      capped: true,
      cap: 60,
      reasons: [{ kind: 'critical-vuln', count: 1 }],
    });
    expect(snapshot.overall).toBe(60);
    expect(snapshot.grade).toBe('C');
  });

  it('红线未触发时不得封顶（否则写分错误会被美化成「红线压制」）', () => {
    const snapshot = computeOverallSnapshot([dim('quality', 95, 1)], {
      capped: false,
      cap: 60,
      reasons: [],
    });
    expect(snapshot.overall).toBe(95);
  });

  it('分级边界与 calculate 一致（90/75/60）', () => {
    expect(computeOverallSnapshot([dim('a', 90, 1)]).grade).toBe('A');
    expect(computeOverallSnapshot([dim('a', 89.9, 1)]).grade).toBe('B');
    expect(computeOverallSnapshot([dim('a', 75, 1)]).grade).toBe('B');
    expect(computeOverallSnapshot([dim('a', 60, 1)]).grade).toBe('C');
    expect(computeOverallSnapshot([dim('a', 59.9, 1)]).grade).toBe('D');
  });

  it('全部 not-run 时总评为 0 且不带红线（不编造分数）', () => {
    const snapshot = computeOverallSnapshot([dim('a', 0, 1, 'not-run')]);
    expect(snapshot.overall).toBe(0);
    expect(snapshot.redLine).toBeUndefined();
  });
});
