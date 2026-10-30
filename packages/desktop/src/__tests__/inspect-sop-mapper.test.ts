import { describe, expect, it } from 'vitest';
import {
  isIssueStatus,
  selectIssueChecks,
  toInspectionReportDataFromRuleEngine,
  toInspectOutcome,
} from '../pages/inspect-sop-mapper';

/**
 * P0-3（2026-10-04）：巡检执行失败被静默吞掉，落成"从未运行"空态。
 * runPipeline 失败时不抛异常，而是返回 { passed:false, error:'IPC not available' }
 * 且不带 inspect 字段；inspect-logic 直接把 pipeline.inspect（undefined）喂给映射器，
 * 映射器返回 null，页面于是显示"一键体检"空态——用户看不出体检根本没跑成。
 * toInspectOutcome 把三种结果（成功 / 后端报错 / 无有效载荷）显式区分。
 */

/**
 * P0-1（2026-09-24 排查闭环）：巡检页把 skipped 评估显示为"问题"。
 * 用户报告里【问题 5】type-consistency 显示"跳过 check-list→GuardEngine.run
 * （防止规则引擎重入）"——root cause 是巡检页 issues 统计/明细把 attention
 * （skipped/error 的映射态）与 fail 混为一谈：
 *  - InspectPage.tsx:176 issues 数 = items.length - passCount（含 attention）
 *  - InspectPage.tsx:179 明细 = status !== 'pass'（含 attention）
 * 这是展示层缺陷：attention 语义是"未检测/需关注"，不是"有问题"。
 * skipped 评估不该进入"问题"列表，只作为未检测提示存在。
 */

describe('isIssueStatus — 问题判定：attention（未检测）不算问题', () => {
  it('fail/warn 是问题', () => {
    expect(isIssueStatus('fail')).toBe(true);
    expect(isIssueStatus('warn')).toBe(true);
  });

  it('pass/attention 不是问题（attention = 未检测/需关注，非缺陷）', () => {
    expect(isIssueStatus('pass')).toBe(false);
    expect(isIssueStatus('attention')).toBe(false);
  });
});

describe('toInspectionReportDataFromRuleEngine — skipped 评估不产问题条目', () => {
  const skippedOnlyReport = {
    total: 2,
    passed: 1,
    failed: 0,
    errors: 0,
    skipped: 1,
    ok: true,
    durationMs: 500,
    timestamp: '2026-09-24T08:00:00.000Z',
    evaluations: [
      {
        rule: {
          id: 'inspect.scan.official.type-consistency',
          name: 'TypeScript Type Consistency',
          domain: 'inspect',
        },
        status: 'skipped' as const,
        message: '跳过 check-list→GuardEngine.run（防止规则引擎重入）',
        timestamp: '2026-09-24T08:00:00.000Z',
      },
      {
        rule: {
          id: 'inspect.scan.official.type-safety',
          name: 'TypeScript Type Safety',
          domain: 'inspect',
        },
        status: 'passed' as const,
        timestamp: '2026-09-24T08:00:00.000Z',
      },
    ],
  };

  it('skipped 评估映射为 attention 检查项（保留未检测提示）', () => {
    const data = toInspectionReportDataFromRuleEngine(skippedOnlyReport);
    expect(data).not.toBeNull();
    const skipped = data!.checks.find((c) => c.name === 'TypeScript Type Consistency');
    expect(skipped?.status).toBe('attention');
    expect(skipped?.detail).toContain('跳过 check-list');
  });

  it('attention 不计入 failures 摘要', () => {
    const data = toInspectionReportDataFromRuleEngine(skippedOnlyReport);
    expect(data!.summary.failures).toBe(0);
    // 语义不变量：failures 只来自 fail 检查项
    expect(data!.summary.failures).toBe(
      data!.checks.filter((c) => c.status === 'fail').length,
    );
  });

  it('selectIssueChecks 从全量 checks 中排除 attention（巡检页问题列表的唯一数据源）', () => {
    const data = toInspectionReportDataFromRuleEngine(skippedOnlyReport);
    const issues = selectIssueChecks(data!.checks);
    expect(issues).toHaveLength(0);
    expect(issues.some((c) => c.status === 'attention')).toBe(false);
  });

  it('fail 检查项进入问题列表，attention 不进入', () => {
    const mixedReport = {
      total: 3,
      passed: 0,
      failed: 1,
      errors: 0,
      skipped: 1,
      ok: false,
      durationMs: 500,
      timestamp: '2026-09-24T08:00:00.000Z',
      evaluations: [
        {
          rule: { id: 'r-skipped', name: 'Skipped Rule', domain: 'inspect' },
          status: 'skipped' as const,
          message: '工具不可用',
        },
        {
          rule: { id: 'r-fail', name: 'Failed Rule', domain: 'inspect' },
          status: 'failed' as const,
          violations: [
            {
              severity: 'warning',
              file: 'src/a.ts',
              line: 1,
              message: 'violation-1',
              category: 'quality',
            },
          ],
        },
        {
          rule: { id: 'r-pass', name: 'Passed Rule', domain: 'inspect' },
          status: 'passed' as const,
        },
      ],
    };
    const data = toInspectionReportDataFromRuleEngine(mixedReport);
    expect(data).not.toBeNull();
    const issues = selectIssueChecks(data!.checks);
    expect(issues.map((c) => c.id)).toEqual(['r-fail']);
  });
});

describe('toInspectOutcome — 执行失败不再退化为"从未运行"空态', () => {
  const validReport = {
    total: 1,
    passed: 1,
    failed: 0,
    errors: 0,
    skipped: 0,
    ok: true,
    durationMs: 120,
    timestamp: '2026-10-04T08:00:00.000Z',
    evaluations: [
      {
        rule: { id: 'r-pass', name: 'Passed Rule', domain: 'inspect' },
        status: 'passed' as const,
      },
    ],
  };

  it('Given 后端回报 error 且无 inspect，Then 判定为 failed 并透出后端原因', () => {
    const outcome = toInspectOutcome({ error: 'IPC not available' });
    expect(outcome).toMatchObject({ kind: 'failed', detail: 'IPC not available' });
  });

  it('Given 无 error 但 inspect 缺失，Then 判定为 failed（无载荷）而非 report', () => {
    const outcome = toInspectOutcome({});
    expect(outcome.kind).toBe('failed');
    expect(outcome).toMatchObject({ messageKey: 'page.inspect.errorNoReport' });
  });

  it('Given inspect 形状非法，Then 判定为 failed 而非静默落空态', () => {
    const outcome = toInspectOutcome({ inspect: { unexpected: true } });
    expect(outcome.kind).toBe('failed');
  });

  it('Given 合法 inspect 载荷，Then 判定为 report 并带上映射后的检查项', () => {
    const outcome = toInspectOutcome({ inspect: validReport });
    if (outcome.kind !== 'report') {
      throw new Error(`期望 report，实际 ${outcome.kind}`);
    }
    expect(outcome.report.checks).toHaveLength(1);
    expect(outcome.report.checks[0]?.status).toBe('pass');
  });

  it('Given error 为 null（后端显式无错），Then 不算失败', () => {
    expect(toInspectOutcome({ error: null, inspect: validReport }).kind).toBe('report');
  });

  it('Given 后端 error 与有效载荷并存，Then 以 error 为准（失败优先）', () => {
    const outcome = toInspectOutcome({ error: 'boom', inspect: validReport });
    expect(outcome.kind).toBe('failed');
  });
});

describe('toInspectionReportDataFromRuleEngine — 不适用（not-applicable）语义', () => {
  const notApplicableReport = {
    total: 2,
    // 引擎侧已把不适用项从 passed 中剔除
    passed: 1,
    failed: 0,
    errors: 0,
    skipped: 0,
    notApplicable: 1,
    ok: true,
    durationMs: 500,
    timestamp: '2026-10-31T08:00:00.000Z',
    evaluations: [
      {
        rule: { id: 'security.web.helmet-check', name: 'Helmet Check', domain: 'security' },
        status: 'passed' as const,
        applicability: 'not-applicable' as const,
        message: '项目未使用 Web 框架，Helmet 检查不适用',
      },
      {
        rule: { id: 'inspect.scan.type-safety', name: 'Type Safety', domain: 'inspect' },
        status: 'passed' as const,
      },
    ],
  };

  it('不适用评估映射为 notApplicable，而不是 pass', () => {
    const data = toInspectionReportDataFromRuleEngine(notApplicableReport);
    expect(data).not.toBeNull();
    const helmet = data!.checks.find((c) => c.name === 'Helmet Check');
    expect(helmet?.status).toBe('notApplicable');
    // 详情保留原因，用户能看到「为什么没查」
    expect(helmet?.detail).toContain('未使用 Web 框架');
  });

  it('不适用不进入问题列表，也不计入通过数', () => {
    const data = toInspectionReportDataFromRuleEngine(notApplicableReport);
    expect(selectIssueChecks(data!.checks)).toHaveLength(0);
    // summary.passed 只来自真正通过的检查项（不适用项 status 已不是 pass）
    expect(data!.summary.passed).toBe(1);
    expect(data!.summary.notApplicable).toBe(1);
    // total 仍覆盖全部检查项，且各档之和守恒
    expect(data!.summary.passed + data!.summary.warnings + data!.summary.failures + (data!.summary.notApplicable ?? 0)).toBe(data!.summary.total);
  });
});