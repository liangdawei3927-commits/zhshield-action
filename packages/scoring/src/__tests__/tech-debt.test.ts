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

function makeInput(
  issues: DebtIssueInput[],
  hotness: ModuleHotnessInput[] = [],
  exposed: string[] = [],
): TechDebtInput {
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

  it('should strip ../ prefixes', () => {
    expect(moduleOf('../../../src/foo.ts')).toBe('src/foo.ts');
    expect(moduleOf('../../bar.ts')).toBe('bar.ts');
    expect(moduleOf('../baz.ts')).toBe('baz.ts');
  });

  it('should strip leading / from absolute paths', () => {
    expect(moduleOf('/tmp/zh-nav-fixture/src/type-error.ts')).toBe(
      'tmp/zh-nav-fixture/src/type-error.ts',
    );
    expect(moduleOf('/absolute/deep/path.ts')).toBe('absolute/deep/path.ts');
    expect(moduleOf('/')).toBe('(root)');
  });

  it('should combine ../ stripping and leading / removal', () => {
    expect(moduleOf('../../../tmp/zh-nav-fixture/src/type-error.ts')).toBe(
      'tmp/zh-nav-fixture/src/type-error.ts',
    );
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
    const hotIssue: DebtIssueInput = {
      id: 'h1',
      severity: 'error',
      category: 'security',
      file: 'src/hot.ts',
    };
    const coldIssue: DebtIssueInput = {
      id: 'c1',
      severity: 'error',
      category: 'security',
      file: 'src/cold.ts',
    };
    const hot = buildTechDebtDashboard(
      makeInput([hotIssue], [{ module: 'src/hot.ts', commitCount: 50 }]),
    ).actionList.find((a) => a.module === 'src/hot.ts');
    const cold = buildTechDebtDashboard(makeInput([coldIssue])).actionList.find(
      (a) => a.module === 'src/cold.ts',
    );
    expect(hot!.interestScore).toBeGreaterThan(cold!.interestScore);
    expect(hot!.interestBreakdown.hotnessFactor).toBeGreaterThan(
      cold!.interestBreakdown.hotnessFactor,
    );
  });

  it('安全敞口：对外接口文件加权', () => {
    const exposedIssue: DebtIssueInput = {
      id: 'e1',
      severity: 'error',
      category: 'security',
      file: 'src/routes.ts',
    };
    const normalIssue: DebtIssueInput = {
      id: 'n1',
      severity: 'error',
      category: 'security',
      file: 'src/lib.ts',
    };
    const exposed = buildTechDebtDashboard(
      makeInput([exposedIssue], [], ['src/routes.ts']),
    ).actionList.find((a) => a.module === 'src/routes.ts');
    const normal = buildTechDebtDashboard(makeInput([normalIssue])).actionList.find(
      (a) => a.module === 'src/lib.ts',
    );
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
      {
        actionId: 'td-security-abc',
        status: 'pending',
        module: 'src/a.ts',
        category: 'security' as const,
      } as import('../tech-debt/types').DebtAction,
      {
        actionId: 'td-quality-def',
        status: 'pending',
        module: 'src/b.ts',
        category: 'quality' as const,
      } as import('../tech-debt/types').DebtAction,
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
    const original = [
      { actionId: 'x', status: 'pending' as const },
    ] as import('../tech-debt/types').DebtAction[];
    mergeActionStatuses(original, [{ actionId: 'x', status: 'repaid' as const }]);
    expect(original[0].status).toBe('pending');
  });
});

describe('tech-debt: actionId 唯一性', () => {
  const MONOREPO_FILES = [
    'packages/cli/src/index.ts',
    'packages/inspect/src/adapters/ts-prune-adapter.ts',
    'packages/kernel/src/runner/scan-utils.ts',
    'packages/server/src/main.ts',
    'packages/guard/src/guard-report-store.ts',
  ];

  it('共享 9 字节前缀的模块不得塌缩为同一 actionId', () => {
    const snap = buildTechDebtDashboard(
      makeInput(
        MONOREPO_FILES.map((file, i) => ({
          id: `i${i}`,
          severity: 'error' as const,
          category: 'performance' as const,
          file,
        })),
      ),
    );
    expect(snap.actionList).toHaveLength(MONOREPO_FILES.length);
    expect(new Set(snap.actionList.map((a) => a.actionId)).size).toBe(MONOREPO_FILES.length);
  });

  it('actionId 格式为 td-<category>-<12 位十六进制>且跨类别不重复', () => {
    const snap = buildTechDebtDashboard(
      makeInput([
        { id: 's', severity: 'error', category: 'security', file: 'src/a.ts' },
        { id: 'q', severity: 'warning', category: 'quality', file: 'src/a.ts' },
      ]),
    );
    for (const action of snap.actionList) {
      expect(action.actionId).toMatch(/^td-[a-z]+-[0-9a-f]{12}$/);
    }
    expect(new Set(snap.actionList.map((a) => a.actionId)).size).toBe(2);
  });

  it('同输入重复构建得到相同 actionId', () => {
    const issues: DebtIssueInput[] = [
      { id: 'a', severity: 'error', category: 'security', file: 'packages/cli/src/index.ts' },
    ];
    expect(buildTechDebtDashboard(makeInput(issues)).actionList[0].actionId).toBe(
      buildTechDebtDashboard(makeInput(issues)).actionList[0].actionId,
    );
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

/**
 * 非有限值不变量（2026-10-02 回归）。
 *
 * dashboard 内部用 Math.max(len, 1) 防除零，但真正该守住的是「对外快照里
 * 不出现 NaN/Infinity」——NaN 一旦进 interestScore/roi/sort，会静默把整张
 * 推荐榜排成乱序，而不是抛错。此处对公开 API 全量递归扫描，边界入参全覆盖。
 */
describe('tech-debt: 快照不含 NaN/Infinity', () => {
  function findNonFinite(value: unknown, path = '$'): string[] {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? [] : [`${path}=${String(value)}`];
    }
    if (Array.isArray(value)) {
      return value.flatMap((v, i) => findNonFinite(v, `${path}[${i}]`));
    }
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([k, v]) => findNonFinite(v, `${path}.${k}`));
    }
    return [];
  }

  const CASES: Array<[string, DebtIssueInput[], ModuleHotnessInput[], string[]]> = [
    ['空输入', [], [], []],
    [
      '单条 error',
      [{ id: '1', severity: 'error', category: 'security', file: 'src/a.ts' }],
      [],
      [],
    ],
    [
      '单条 info（零权重路径）',
      [{ id: '1', severity: 'info', category: 'documentation', file: 'src/a.ts' }],
      [],
      [],
    ],
    [
      '同模块多类别聚合',
      [
        { id: 'a', severity: 'error', category: 'security', file: 'src/api/a.ts' },
        { id: 'b', severity: 'warning', category: 'performance', file: 'src/api/a.ts' },
        { id: 'c', severity: 'info', category: 'quality', file: 'src/api/a.ts' },
      ],
      [{ module: 'src/api/a.ts', commitCount: 999 }],
      ['src/api/a.ts'],
    ],
    [
      '全部 info（severitySum=0 除以非零长度）',
      Array.from({ length: 4 }, (_, i) => ({
        id: `i${i}`,
        severity: 'info' as const,
        category: 'quality' as const,
        file: `src/q${i}.ts`,
      })),
      [],
      [],
    ],
    [
      '根路径模块（(root) 分组）',
      [{ id: 'r', severity: 'error', category: 'security', file: '/' }],
      [],
      [],
    ],
  ];

  it.each(CASES)('%s → 全快照数值均有限', (_label, issues, hotness, exposed) => {
    const snap = buildTechDebtDashboard(makeInput(issues, hotness, exposed));
    expect(findNonFinite(snap)).toEqual([]);
  });

  it('单条 info 不产生 0/0：interestScore 必须是有限数', () => {
    const snap = buildTechDebtDashboard(
      makeInput([{ id: 'z', severity: 'info', category: 'quality', file: 'src/z.ts' }]),
    );
    for (const action of snap.actionList) {
      expect(Number.isFinite(action.interestScore)).toBe(true);
      expect(Number.isFinite(action.roi)).toBe(true);
      expect(Number.isFinite(action.interestBreakdown.severityFactor)).toBe(true);
    }
  });
});
