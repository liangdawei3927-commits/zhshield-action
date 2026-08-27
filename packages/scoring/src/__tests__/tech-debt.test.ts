import { describe, expect, it } from 'vitest';
import {
  buildTechDebtDashboard,
  computeDebtIndex,
  mapToDebtCategory,
  moduleOf,
  mergeActionStatuses,
  computeTrendDelta,
} from '../tech-debt/dashboard';
import type { DebtIssueInput, ModuleHotnessInput, TechDebtInput } from '../tech-debt/types';

function makeInput(issues: DebtIssueInput[], hotness: ModuleHotnessInput[] = [], exposed: string[] = []): TechDebtInput {
  return { projectId: 'proj-1', issues, moduleHotness: hotness, exposedFiles: exposed };
}

describe('tech-debt: mapToDebtCategory', () => {
  it('映射既有 IssueCategory → DebtCategory', () => {
    expect(mapToDebtCategory('security')).toBe('security');
    expect(mapToDebtCategory('architecture')).toBe('architecture');
    expect(mapToDebtCategory('dependency')).toBe('dependency');
    expect(mapToDebtCategory('refactoring')).toBe('duplication');
    expect(mapToDebtCategory('quality')).toBe('quality');
    expect(mapToDebtCategory('performance')).toBe('quality');
    expect(mapToDebtCategory('documentation')).toBe('quality');
    expect(mapToDebtCategory('test')).toBe('quality');
    expect(mapToDebtCategory('unknown-xyz')).toBe('quality');
  });
});

describe('tech-debt: moduleOf', () => {
  it('提取相对模块路径，兼容反斜杠与前缀', () => {
    expect(moduleOf('src/services/auth.ts')).toBe('src/services/auth.ts');
    expect(moduleOf('./src/a.ts')).toBe('src/a.ts');
    expect(moduleOf('src\\a.ts')).toBe('src/a.ts');
    expect(moduleOf('')).toBe('(root)');
  });
});

describe('tech-debt: computeDebtIndex', () => {
  it('无 issues → 0', () => {
    expect(computeDebtIndex([])).toBe(0);
  });

  it('错误级安全问题加权显著高于 info 质量问题', () => {
    const severe: DebtIssueInput[] = [
      { id: '1', severity: 'error', category: 'security', file: 'src/api.ts' },
    ];
    const mild: DebtIssueInput[] = [
      { id: '2', severity: 'info', category: 'quality', file: 'src/util.ts' },
    ];
    expect(computeDebtIndex(severe)).toBeGreaterThan(computeDebtIndex(mild));
  });

  it('上限 100', () => {
    const many: DebtIssueInput[] = Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`,
      severity: 'error' as const,
      category: 'security',
      file: `src/f${i % 5}.ts`,
    }));
    expect(computeDebtIndex(many)).toBeLessThanOrEqual(100);
  });
});

describe('tech-debt: buildTechDebtDashboard', () => {
  it('空输入 → 零债务快照', () => {
    const snap = buildTechDebtDashboard(makeInput([]));
    expect(snap.debtIndex).toBe(0);
    expect(snap.byModule).toEqual([]);
    expect(snap.byCategory).toEqual([]);
    expect(snap.actionList).toEqual([]);
    expect(snap.projectId).toBe('proj-1');
    expect(snap.trend).toEqual({ period: 'week', delta: 0 });
  });

  it('同模块同类别聚合为一条 action，ROI 降序且 Top 标记 recommended', () => {
    const issues: DebtIssueInput[] = [
      { id: 'a1', severity: 'error', category: 'security', file: 'src/api/auth.ts' },
      { id: 'a2', severity: 'error', category: 'security', file: 'src/api/auth.ts' },
      { id: 'b1', severity: 'warning', category: 'quality', file: 'src/util.ts' },
    ];
    const snap = buildTechDebtDashboard(makeInput(issues));

    // 聚合：auth 模块 security 2 条 → 1 action；util quality 1 条 → 1 action
    expect(snap.actionList).toHaveLength(2);
    const securityAction = snap.actionList.find((a) => a.category === 'security');
    expect(securityAction?.issueIds).toEqual(['a1', 'a2']);
    expect(securityAction?.module).toBe('src/api/auth.ts');
    expect(securityAction?.status).toBe('pending');
    expect(securityAction?.principalEstimate).toBe(4); // security 2 人天 × 2 条
    expect(securityAction?.interestBreakdown).toHaveProperty('severityFactor');
    expect(securityAction?.interestBreakdown).toHaveProperty('hotnessFactor');
    expect(securityAction?.interestBreakdown).toHaveProperty('densityFactor');
    expect(securityAction?.interestBreakdown).toHaveProperty('exposureFactor');

    // ROI 降序
    const rois = snap.actionList.map((a) => a.roi);
    expect(rois.toSorted((x, y) => y - x)).toEqual(rois);
    expect(snap.actionList[0].recommended).toBe(true);
  });

  it('模块热度影响利息：高热度模块同问题利息更高', () => {
    const hotIssue: DebtIssueInput = { id: 'h1', severity: 'error', category: 'security', file: 'src/hot.ts' };
    const coldIssue: DebtIssueInput = { id: 'c1', severity: 'error', category: 'security', file: 'src/cold.ts' };
    const hot = buildTechDebtDashboard(
      makeInput([hotIssue], [{ module: 'src/hot.ts', commitCount: 50 }]),
    ).actionList.find((a) => a.module === 'src/hot.ts');
    const cold = buildTechDebtDashboard(makeInput([coldIssue])).actionList.find((a) => a.module === 'src/cold.ts');
    expect(hot!.interestScore).toBeGreaterThan(cold!.interestScore);
    expect(hot!.interestBreakdown.hotnessFactor).toBeGreaterThan(cold!.interestBreakdown.hotnessFactor);
  });

  it('安全敞口：对外接口文件加权', () => {
    const exposedIssue: DebtIssueInput = { id: 'e1', severity: 'error', category: 'security', file: 'src/routes.ts' };
    const normalIssue: DebtIssueInput = { id: 'n1', severity: 'error', category: 'security', file: 'src/lib.ts' };
    const exposed = buildTechDebtDashboard(
      makeInput([exposedIssue], [], ['src/routes.ts']),
    ).actionList.find((a) => a.module === 'src/routes.ts');
    const normal = buildTechDebtDashboard(makeInput([normalIssue])).actionList.find((a) => a.module === 'src/lib.ts');
    expect(exposed!.interestBreakdown.exposureFactor).toBe(1.5);
    expect(normal!.interestBreakdown.exposureFactor).toBe(1);
  });

  it('byModule 按利息降序且 debtShare 归一化', () => {
    const issues: DebtIssueInput[] = [
      { id: '1', severity: 'error', category: 'security', file: 'src/a.ts' },
      { id: '2', severity: 'error', category: 'security', file: 'src/a.ts' },
      { id: '3', severity: 'info', category: 'quality', file: 'src/b.ts' },
    ];
    const snap = buildTechDebtDashboard(makeInput(issues));
    expect(snap.byModule[0].module).toBe('src/a.ts');
    const shares = snap.byModule.reduce((acc, m) => acc + m.debtShare, 0);
    expect(shares).toBeCloseTo(1, 1);
  });

  it('byCategory 聚合计数与权重', () => {
    const issues: DebtIssueInput[] = [
      { id: '1', severity: 'error', category: 'security', file: 'src/a.ts' },
      { id: '2', severity: 'error', category: 'security', file: 'src/b.ts' },
      { id: '3', severity: 'warning', category: 'refactoring', file: 'src/c.ts' },
    ];
    const snap = buildTechDebtDashboard(makeInput(issues));
    const security = snap.byCategory.find((c) => c.category === 'security');
    const duplication = snap.byCategory.find((c) => c.category === 'duplication');
    expect(security?.count).toBe(2);
    expect(duplication?.count).toBe(1);
    // security 权重最高（error × 3 × CATEGORY_WEIGHT 3）
    expect(snap.byCategory[0].category).toBe('security');
  });
});

describe('tech-debt: mergeActionStatuses', () => {
  it('overrides status for matching actionIds from persisted', () => {
    const actions = [
      { actionId: 'td-security-abc', status: 'pending', module: 'src/a.ts', category: 'security' as const } as import('../tech-debt/types').DebtAction,
      { actionId: 'td-quality-def', status: 'pending', module: 'src/b.ts', category: 'quality' as const } as import('../tech-debt/types').DebtAction,
    ];
    const persisted = [{ actionId: 'td-security-abc', status: 'planned' as const }];
    const result = mergeActionStatuses(actions, persisted);
    expect(result[0].status).toBe('planned');
    expect(result[1].status).toBe('pending');
  });

  it('returns unchanged actions when persisted is empty', () => {
    const actions = [
      { actionId: 'x', status: 'pending' } as import('../tech-debt/types').DebtAction,
    ];
    const result = mergeActionStatuses(actions, []);
    expect(result[0].status).toBe('pending');
  });

  it('does not mutate original array', () => {
    const original = [{ actionId: 'x', status: 'pending' as const }] as import('../tech-debt/types').DebtAction[];
    mergeActionStatuses(original, [{ actionId: 'x', status: 'repaid' as const }]);
    expect(original[0].status).toBe('pending');
  });
});

describe('tech-debt: computeTrendDelta', () => {
  it('returns current - previous when previous is non-null', () => {
    expect(computeTrendDelta(50, 45)).toBe(5);
    expect(computeTrendDelta(30, 40)).toBe(-10);
  });

  it('returns 0 when previous is null', () => {
    expect(computeTrendDelta(50, null)).toBe(0);
  });

  it('returns 0 when current equals previous', () => {
    expect(computeTrendDelta(42, 42)).toBe(0);
  });
});
