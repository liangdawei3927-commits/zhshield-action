/**
 * P1-9 回归：0 覆盖不给满分（refactor-coverage.test.ts）
 *
 * 缺陷：重构引擎只收 .ts/.tsx 文件，纯 JS 项目 scannedFiles=0、totalSmells=0
 * → refactorPenalty(0)=0 → 100 分。用户看到"重构 100 分"以为代码很干净，
 * 实际是"一个文件都没看"——覆盖率缺口被显示成满分。
 *
 * 修复：extras.refactor.scannedFiles === 0 → 维度判 not-run（前端已有 '—' 展示）；
 * scannedFiles 缺省（旧版 dashboard-state 未上报覆盖数）保持 scored，不误伤历史数据。
 */
import { describe, it, expect } from 'vitest';
import { buildHealthDimensions } from '../pipeline-score';
import type { DimensionExtras } from '../types';

const cleanGuard = { results: [] };
const cleanInspect = { issues: [] };

function extrasWith(
  refactor: NonNullable<DimensionExtras['refactor']>,
): DimensionExtras {
  return {
    secrets: { activeCount: 0 },
    deps: { vulnerabilities: { critical: 0, high: 0, medium: 0 }, upgradable: 0 },
    techdebt: { debtIndex: 0, issueCount: 0 },
    sentinel: { active: true, criticalEvents: 0, warningEvents: 0 },
    refactor,
    performance: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
    garbage: { total: 0, byType: {} },
    backup: {
      lastSuccessAt: new Date().toISOString(),
      recentStatuses: ['success'],
      scheduleEnabled: true,
    },
  };
}

function refactorDim(extras: DimensionExtras): { score: number; issues: number; status: string } {
  const dim = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras }).find(
    (d) => d.name === 'refactor',
  );
  expect(dim, 'refactor 维度必须存在').toBeTruthy();
  return { score: dim!.score, issues: dim!.issues, status: dim!.status };
}

describe('scoreRefactor — 0 覆盖判 not-run（P1-9）', () => {
  it('真阳性：scannedFiles=0（纯 JS 项目）→ not-run，不出现 100 分', () => {
    const dim = refactorDim(
      extrasWith({ totalSmells: 0, bySeverity: { error: 0, warning: 0, info: 0 }, scannedFiles: 0 }),
    );
    expect(dim.status).toBe('not-run');
    expect(dim.score).toBe(0);
    expect(dim.issues).toBe(0);
  });

  it('误报防护：scannedFiles>0 且无异味 → 正常 scored 100 分', () => {
    const dim = refactorDim(
      extrasWith({ totalSmells: 0, bySeverity: { error: 0, warning: 0, info: 0 }, scannedFiles: 12 }),
    );
    expect(dim.status).toBe('scored');
    expect(dim.score).toBe(100);
  });

  it('向后兼容：scannedFiles 缺省（旧版 dashboard-state）→ 保持 scored，不误判历史数据', () => {
    const dim = refactorDim(
      extrasWith({ totalSmells: 0, bySeverity: { error: 0, warning: 0, info: 0 } }),
    );
    expect(dim.status).toBe('scored');
    expect(dim.score).toBe(100);
  });
});
