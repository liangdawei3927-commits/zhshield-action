/**
 * normalizeRuleEngine 的 toolError 打标（2026-10-26）。
 *
 * 背景：打包版工具跑不起来（semgrep/dep-cruiser/eslint 配置在 asar 内不可读）时，
 * 规则评估 status='error' 且无 violation 明细。归一化层为「UI 有内容可显示」
 * 把这类评估落成 warning 条目 —— 但它们不是代码问题，必须打 toolError 标记
 * 供评分链路豁免（见 report-summary.toInspectIssues / zh-diagnostics-persist）。
 */
import { describe, expect, it } from 'vitest';
import { normalizeInspectSource } from '../../electron/zh-diagnostics-normalize';
import type { RuleEngineReport, RuleEvaluation } from '@zh/kernel';

function evaluation(partial: Partial<RuleEvaluation>): RuleEvaluation {
  return {
    rule: { id: 'inspect.scan.official.path-traversal', name: '路径穿越' },
    status: 'error',
    message: '工具 semgrep 错误: unable to find a config',
    durationMs: 10,
    timestamp: new Date('2026-10-26T00:00:00Z'),
    ...partial,
  } as RuleEvaluation;
}

function report(evals: RuleEvaluation[]): RuleEngineReport {
  return {
    total: evals.length,
    passed: 0,
    failed: 0,
    errors: evals.length,
    skipped: 0,
    ok: false,
    evaluations: evals,
    durationMs: 10,
  } as unknown as RuleEngineReport;
}

describe('normalizeInspectSource（RuleEngineReport）的 toolError 打标', () => {
  it('error 评估（无 violation）→ 条目带 toolError: true', () => {
    const entries = normalizeInspectSource(report([evaluation({})]), 'inspect');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolError).toBe(true);
    expect(entries[0]?.severity).toBe('warning');
  });

  it('failed 评估（规则真检出失败）→ 不带 toolError，照常扣分', () => {
    const entries = normalizeInspectSource(
      report([evaluation({ status: 'failed', message: '规则失败' })]),
      'inspect',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolError).toBeUndefined();
    expect(entries[0]?.severity).toBe('error');
  });

  it('有 violation 明细的评估走 violation 分支，不产生 toolError 条目', () => {
    const entries = normalizeInspectSource(
      report([
        evaluation({
          status: 'error',
          violations: [
            {
              id: 'v1',
              ruleId: 'inspect.scan.official.path-traversal',
              severity: 'medium',
              file: 'src/a.ts',
              message: '路径拼接来自外部输入',
              category: 'quality',
            },
          ],
        }),
      ]),
      'inspect',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolError).toBeUndefined();
    expect(entries[0]?.message).toBe('路径拼接来自外部输入');
  });
});
