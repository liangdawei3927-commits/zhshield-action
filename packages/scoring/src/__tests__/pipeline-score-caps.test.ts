import { describe, it, expect } from 'vitest';
import {
  buildHealthDimensions,
  PERFORMANCE_SEVERITY_CAP,
  PERFORMANCE_SEVERITY_PENALTY,
  type GuardReportLike,
  type InspectionReportLike,
} from '../pipeline-score';

const cleanGuard: GuardReportLike = { results: [] };
const cleanInspect: InspectionReportLike = { issues: [] };

/**
 * performance 维度「单级封顶」回归。
 *
 * 旧口径是裸线性累加 + 全局上限：同一 severity 堆积到 23 条时，加权值就撞满
 * 全局 100，此后该维度无论再发现多少问题、也别的问题多严重，分数都不再变化——
 * 1% 的问题项吃光整维，其余 99% 全部不可见。改为逐 severity 封顶后求和，
 * 单级贡献有界，Σ 五级封顶恰好 100，与全局上限对齐。
 */
describe('performance 单级封顶', () => {
  const perf = (total: number, bySeverity: Partial<Record<'critical' | 'high' | 'medium' | 'low' | 'info', number>>) =>
    buildHealthDimensions(cleanGuard, cleanInspect, undefined, undefined, {
      performance: {
        total,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, ...bySeverity },
      },
    }).find((d) => d.name === 'performance')!;

  it('低量级不受封顶影响：1 critical + 1 medium + 1 low → 89', () => {
    // min(40, 8)=8 + min(15, 2)=2 + min(5, 1)=1 → penalty 11
    const d = perf(3, { critical: 1, medium: 1, low: 1 });
    expect(d.status).toBe('scored');
    expect(d.score).toBe(89);
    expect(d.issues).toBe(3);
  });

  it('单级封顶生效：high 100 → penalty 40 → 60（旧口径 400 触底 0）', () => {
    const d = perf(100, { high: 100 });
    expect(d.score).toBe(60);
    expect(d.issues).toBe(100);
  });

  it('真实量级回归：45 high + 5 medium 不得触底 0（旧口径 190 触顶 → 0 分）', () => {
    // min(40, 45×4)=40 + min(15, 5×2)=10 → penalty 50
    const d = perf(50, { high: 45, medium: 5 });
    expect(d.status).toBe('scored');
    expect(d.score).toBe(50);
    expect(d.issues).toBe(50);
  });

  it('全等级同时触顶仍为 0，且不出现负分', () => {
    // 40+40+15+5+0 = 100 → score 0
    const d = perf(500, { critical: 100, high: 100, medium: 100, low: 100, info: 100 });
    expect(d.score).toBe(0);
  });

  it('封顶后仍保留分辨率：分处不同等级的两批问题可区分', () => {
    // 旧口径下两组加权值都撞全局 100，分数完全相同（均为 0）、无法分辨
    const allHigh = perf(30, { high: 30 });
    const spread = perf(30, { high: 20, medium: 10 });
    expect(allHigh.score).not.toBe(spread.score);
    expect(allHigh.score).toBe(60); // min(40, 30×4) = 40
    expect(spread.score).toBe(45); // min(40, 20×4) + min(15, 10×2) = 40 + 15
  });

  it('cap 总和与全局上限对齐，info 级不计分', () => {
    const capTotal = Object.values(PERFORMANCE_SEVERITY_CAP).reduce((a, b) => a + b, 0);
    expect(capTotal).toBe(100);
    expect(PERFORMANCE_SEVERITY_PENALTY.info).toBe(0);
    expect(PERFORMANCE_SEVERITY_CAP.info).toBe(0);
  });
});
