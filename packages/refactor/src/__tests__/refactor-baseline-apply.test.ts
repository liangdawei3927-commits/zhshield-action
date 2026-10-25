import { describe, it, expect } from 'vitest';
import { applyRefactorBaseline } from '../baseline';
import type { CodeSmell, RefactorReport } from '../types';

/**
 * 重构棘轮基线过滤的双自证门：
 * - 正向：基线内的存量被压制（用户不再看到全量刷屏），增量保留且计数打印；
 * - 反向：已修复（resolved）被识别、空基线等价不过滤（零回归）。
 */

const ROOT = '/proj';

let seq = 0;
function makeSmell(
  ruleId: string,
  severity: CodeSmell['severity'] = 'warning',
  category = 'structural',
): CodeSmell {
  seq += 1;
  return {
    id: `smell-${seq}`,
    ruleId,
    category,
    severity,
    message: `${ruleId} #${seq}`,
    location: { filePath: `${ROOT}/a.ts`, startLine: seq, startColumn: 1, endLine: seq, endColumn: 1 },
    context: { metric: 'lines', value: seq, threshold: 0 },
    suggestion: { type: 'split', description: '拆分', priority: 'low', effort: 'small', edits: [] },
  } as unknown as CodeSmell;
}

function makeReport(file: string, smells: CodeSmell[]): RefactorReport {
  return {
    timestamp: '2026-10-25T00:00:00.000Z',
    projectRoot: ROOT,
    totalFiles: 1,
    scannedFiles: 1,
    totalSmells: smells.length,
    byCategory: smells.reduce(
      (acc, s) => ({ ...acc, [s.category]: (acc[s.category] ?? 0) + 1 }),
      {} as Record<string, number>,
    ),
    bySeverity: smells.reduce(
      (acc, s) => ({ ...acc, [s.severity]: (acc[s.severity] ?? 0) + 1 }),
      { error: 0, warning: 0, info: 0 } as RefactorReport['bySeverity'],
    ),
    files: [
      {
        filePath: `${ROOT}/${file}`,
        totalSmells: smells.length,
        smells,
        maintainabilityScore: 100,
        refactorPriority: 'critical',
      },
    ],
    summary: {
      criticalFiles: 1,
      needsImmediateAction: 1,
      suggestionsByType: smells.reduce(
        (acc, s) => ({ ...acc, [s.suggestion.type]: (acc[s.suggestion.type] ?? 0) + 1 }),
        {} as Record<string, number>,
      ),
    },
  };
}

describe('applyRefactorBaseline — 棘轮过滤双自证', () => {
  it('增量保留：5 处存量基线 2 处 → 保留 3 条增量、压制 2 条（打印计数自证）', () => {
    const smells = Array.from({ length: 5 }, () => makeSmell('large-class'));
    const report = makeReport('a.ts', smells);
    const result = applyRefactorBaseline(report, { 'a.ts': { 'large-class': 2 } }, ROOT);

    console.log(
      `[refactor-baseline gate] 保留=${result.report.totalSmells} 压制=${result.suppressedCount} introduced=${result.introduced.length}`,
    );
    expect(result.report.totalSmells).toBe(3);
    expect(result.suppressedCount).toBe(2);
    expect(result.report.files).toHaveLength(1);
    expect(result.report.files[0].smells).toHaveLength(3);
    // 压制的是组内前 allowed 条（确定性），保留的是后半增量
    expect(result.report.files[0].smells.every((s) => !smells.slice(0, 2).includes(s))).toBe(true);
    // introduced 明细：超基线 3 条
    expect(result.introduced).toEqual([
      { file: 'a.ts', rule: 'large-class', current: 5, baseline: 2 },
    ]);
    // 汇总口径重算一致
    expect(result.report.bySeverity.warning).toBe(3);
    expect(result.report.byCategory.structural).toBe(3);
    expect(result.report.summary.suggestionsByType.split).toBe(3);
  });

  it('全部压制：基线覆盖所有异味 → 文件移除、汇总归零', () => {
    const smells = [makeSmell('large-class', 'error'), makeSmell('long-method')];
    const report = makeReport('a.ts', smells);
    const result = applyRefactorBaseline(
      report,
      { 'a.ts': { 'large-class': 1, 'long-method': 1 } },
      ROOT,
    );

    expect(result.report.totalSmells).toBe(0);
    expect(result.report.files).toHaveLength(0);
    expect(result.suppressedCount).toBe(2);
    expect(result.report.bySeverity.error).toBe(0);
    expect(result.report.summary.criticalFiles).toBe(0);
    expect(result.introduced).toHaveLength(0);
  });

  it('已修复识别：基线 5 当前 2 → 剩余 2 条仍在基线配额内被压制、resolved 记录差额', () => {
    const smells = Array.from({ length: 2 }, () => makeSmell('large-class'));
    const report = makeReport('a.ts', smells);
    const result = applyRefactorBaseline(report, { 'a.ts': { 'large-class': 5 } }, ROOT);

    // 棘轮语义：压制数 = min(基线, 当前)；修复后报告归零，差额由 resolved 带出（重新捕获可收紧）
    expect(result.suppressedCount).toBe(2);
    expect(result.report.totalSmells).toBe(0);
    expect(result.resolved).toEqual([
      { file: 'a.ts', rule: 'large-class', current: 2, baseline: 5 },
    ]);
  });

  it('空基线等价不过滤（零回归）：报告原样保留', () => {
    const smells = Array.from({ length: 4 }, () => makeSmell('long-method'));
    const report = makeReport('a.ts', smells);
    const result = applyRefactorBaseline(report, {}, ROOT);

    expect(result.report.totalSmells).toBe(4);
    expect(result.report.files).toHaveLength(1);
    expect(result.suppressedCount).toBe(0);
  });

  it('文件级评分按过滤后重算：5 error 存量 4 → 保留 1 error，优先级 high、可维护性 85', () => {
    const smells = Array.from({ length: 5 }, () => makeSmell('god-object', 'error'));
    const report = makeReport('a.ts', smells);
    const result = applyRefactorBaseline(report, { 'a.ts': { 'god-object': 4 } }, ROOT);

    expect(result.report.totalSmells).toBe(1);
    // 1 个 error → calculatePriority 给 high（不是 low）；不再是 critical
    expect(result.report.files[0].refactorPriority).toBe('high');
    expect(result.report.files[0].maintainabilityScore).toBe(85); // 100 - 15
    expect(result.report.summary.criticalFiles).toBe(0);
    // high 仍计入 needsImmediateAction —— 与引擎口径一致
    expect(result.report.summary.needsImmediateAction).toBe(1);
  });
});
