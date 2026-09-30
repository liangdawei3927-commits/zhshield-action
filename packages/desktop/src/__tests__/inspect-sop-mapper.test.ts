import { describe, expect, it } from 'vitest';
import {
  isIssueStatus,
  selectIssueChecks,
  toInspectionReportDataFromRuleEngine,
} from '../pages/inspect-sop-mapper';

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