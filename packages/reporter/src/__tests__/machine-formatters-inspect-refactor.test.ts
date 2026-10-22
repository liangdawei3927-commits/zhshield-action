import { describe, it, expect } from 'vitest';
import { buildFindings } from '../machine-formatters';

// InspectionReport / RefactorReport / PipelineReport 的归一覆盖巡检与重构检测两大
// 报告来源。两类「沉默失败」在此守门：status=error 但无 issue 的适配器（工具崩溃）
// 此前在 CI 完全不可见；PipelineReport 的聚合递归遗漏任一阶段都会少报问题。

/** InspectionReport 最小形态（类型守卫需 issues 数组 + summary + score 字段） */
function makeInspectionReport(overrides: Record<string, unknown>) {
  return {
    projectId: 'p',
    timestamp: new Date(),
    scanType: 'full',
    duration: 1,
    score: { overall: 100, grade: 'A' },
    issues: [],
    summary: { total: 0, error: 0, warning: 0, info: 0 },
    adapterResults: [],
    recommendations: [],
    ...overrides,
  };
}

/** RefactorReport 最小形态（类型守卫需 files 数组 + bySeverity） */
function makeRefactorReport(files: unknown[]) {
  return {
    files,
    bySeverity: { error: files.length },
    totalSmells: files.length,
    totalFiles: files.length,
    scannedFiles: files.length,
    timestamp: new Date().toISOString(),
    summary: { criticalFiles: 0, needsImmediateAction: 0 },
  };
}

describe('buildFindings — InspectionReport 归一', () => {
  it('issues 逐条映射，位置/分类/建议字段透传，source 缺失回落 inspect', () => {
    const report = makeInspectionReport({
      issues: [
        {
          ruleId: 'inspect.complexity',
          severity: 'warning',
          message: '圈复杂度过高',
          file: 'src/a.ts',
          line: 8,
          column: 2,
          category: 'quality',
          suggestion: '拆分函数',
        },
        { ruleId: 'inspect.loc', severity: 'info', message: '文件过长', file: 'src/big.ts' },
      ],
    });

    const findings = buildFindings(report);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      ruleId: 'inspect.complexity',
      severity: 'warning',
      file: 'src/a.ts',
      line: 8,
      column: 2,
      category: 'quality',
      suggestion: '拆分函数',
      source: 'inspect',
    });
    expect(findings[1].source).toBe('inspect');
  });

  it('issue 自带 source 时透传——告警路由（security 域走安全面板）依赖该字段', () => {
    const report = makeInspectionReport({
      issues: [
        { ruleId: 'r1', severity: 'error', message: 'm', file: 'a.ts', source: 'security' },
      ],
    });

    expect(buildFindings(report)[0].source).toBe('security');
  });

  it('status=error 且无任何 issue 的适配器必须产出 error finding（带真实原因）——工具崩溃≠零问题', () => {
    const report = makeInspectionReport({
      adapterResults: [
        {
          adapterId: 'eslint',
          adapterName: 'ESLint',
          duration: 100,
          issueCount: 0,
          passed: false,
          status: 'error',
          errorDetail: '缺少 ESLint 配置文件',
          issues: [],
        },
      ],
    });

    const findings = buildFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'eslint',
      severity: 'error',
      source: 'inspect',
    });
    expect(findings[0].message).toContain('检查工具执行失败');
    expect(findings[0].message).toContain('缺少 ESLint 配置文件');
  });

  it('status=error 但 issueCount>0（非零退出码但检出问题）不得误报为工具失败——重复告警会训练用户忽略告警', () => {
    const report = makeInspectionReport({
      adapterResults: [
        {
          adapterId: 'tsc',
          adapterName: 'tsc',
          duration: 100,
          issueCount: 2,
          passed: false,
          status: 'failed',
          issues: [],
        },
      ],
      issues: [
        { ruleId: 'ts1005', severity: 'error', message: '语法错误', file: 'a.ts' },
        { ruleId: 'ts2304', severity: 'error', message: '找不到名称', file: 'b.ts' },
      ],
      summary: { total: 2, error: 2, warning: 0, info: 0 },
    });

    const findings = buildFindings(report);
    expect(findings).toHaveLength(2); // 仅 issues 本身，无额外 error finding
    expect(findings.every((f) => f.ruleId !== 'tsc')).toBe(true);
  });
});

describe('buildFindings — RefactorReport 归一', () => {
  it('smells 逐条映射，location 展开为 file/line/column，suggestion.description 透传', () => {
    const report = makeRefactorReport([
      {
        filePath: 'src/big.ts',
        totalSmells: 1,
        maintainabilityScore: 40,
        refactorPriority: 'high',
        smells: [
          {
            ruleId: 'refactor.long-function',
            severity: 'error',
            message: '函数过长',
            location: { filePath: 'src/big.ts', line: 12, column: 3 },
            category: 'complexity',
            suggestion: { description: '拆分为小函数' },
          },
        ],
      },
    ]);

    const findings = buildFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      ruleId: 'refactor.long-function',
      severity: 'error',
      message: '函数过长',
      file: 'src/big.ts',
      line: 12,
      column: 3,
      category: 'complexity',
      source: 'refactor',
      suggestion: '拆分为小函数',
    });
  });

  it('无 smells 的文件不产出 finding', () => {
    const report = makeRefactorReport([
      { filePath: 'src/clean.ts', totalSmells: 0, maintainabilityScore: 100, refactorPriority: 'low', smells: [] },
    ]);
    expect(buildFindings(report)).toHaveLength(0);
  });
});

describe('buildFindings — PipelineReport 聚合与容错', () => {
  it('聚合 guard/inspect/refactor 三个子报告的 findings——漏一个阶段 CI 就少看一类问题', () => {
    const report = {
      timestamp: new Date(),
      stage: 'complete',
      passed: true,
      guard: {
        ok: false,
        summary: { total: 1, passed: 0, failed: 1 },
        results: [{ checkId: 'guard.chk', status: 'failed', severity: 'error', message: '门禁失败' }],
      },
      inspect: makeInspectionReport({
        issues: [{ ruleId: 'inspect.r', severity: 'warning', message: '巡检问题', file: 'a.ts' }],
      }),
      refactor: makeRefactorReport([
        {
          filePath: 'b.ts',
          totalSmells: 1,
          maintainabilityScore: 50,
          refactorPriority: 'medium',
          smells: [
            { ruleId: 'refactor.r', severity: 'info', message: '异味', location: { filePath: 'b.ts', line: 1, column: 1 } },
          ],
        },
      ]),
    };

    const findings = buildFindings(report);
    expect(findings.map((f) => f.source)).toEqual(['guard', 'inspect', 'refactor']);
  });

  it('null / undefined / 未知形态报告返回空数组——子阶段缺失不得让 SARIF 导出崩溃', () => {
    expect(buildFindings(null)).toHaveLength(0);
    expect(buildFindings(undefined)).toHaveLength(0);
    expect(buildFindings({})).toHaveLength(0);
    expect(buildFindings('not a report')).toHaveLength(0);
    expect(buildFindings({ timestamp: new Date(), stage: 'complete', guard: null, inspect: null, refactor: null })).toHaveLength(0);
  });
});
