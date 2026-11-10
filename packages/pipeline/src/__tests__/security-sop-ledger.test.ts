import { describe, it, expect } from 'vitest';

import { buildRuleChannelLedger, summarizeLedger } from '../domains/security-sop';
import type { RuleEngineReport } from '@zh/kernel';

/**
 * R7：安全域规则通道的逐条账本与计数必须同源。
 *
 * 计数若继续读 `report.skipped` / `report.degraded` 两个汇总字段，就会出现
 * 「账 6 条、明细 9 条」这类分叉；页面据此列明细时，数字和条目对不上。
 */
function reportOf(
  evaluations: Array<{
    id: string;
    status: 'passed' | 'failed' | 'skipped' | 'error';
    degraded?: boolean;
    message?: string;
  }>,
): RuleEngineReport {
  return {
    total: evaluations.length,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    ok: false,
    evaluations: evaluations.map((e) => ({
      rule: { id: e.id, name: `${e.id}-name` },
      status: e.status,
      ...(e.degraded !== undefined ? { degraded: e.degraded } : {}),
      ...(e.message ? { message: e.message } : {}),
      durationMs: 1,
    })),
    durationMs: 1,
    timestamp: new Date(),
  } as unknown as RuleEngineReport;
}

describe('security-sop 规则账本（R7）', () => {
  it('逐条构造账本：ruleId / name / status / reason 透传', () => {
    const ledger = buildRuleChannelLedger(
      reportOf([
        { id: 'security.scan.semgrep.xss', status: 'passed', message: '工具 semgrep 检查通过' },
        { id: 'security.scan.gitleaks.hardcoded-key', status: 'skipped', degraded: true, message: '未注册工具适配器: gitleaks' },
      ]),
    );

    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      ruleId: 'security.scan.semgrep.xss',
      status: 'passed',
      reason: '工具 semgrep 检查通过',
    });
    expect(ledger[1]).toMatchObject({
      ruleId: 'security.scan.gitleaks.hardcoded-key',
      status: 'skipped',
      degraded: true,
    });
  });

  it('计数由账本派生：degraded 与 skipped 互斥，error 计入 degraded', () => {
    const counts = summarizeLedger([
      { ruleId: 'a', name: 'a', status: 'passed' },
      { ruleId: 'b', name: 'b', status: 'failed' },
      { ruleId: 'c', name: 'c', status: 'skipped' },
      { ruleId: 'd', name: 'd', status: 'skipped', degraded: true },
      { ruleId: 'e', name: 'e', status: 'error' },
    ]);

    expect(counts).toEqual({ skipped: 1, degraded: 2 });
  });

  it('空账本 → 两个计数均为 0（不冒充满分，也不伪造缺口）', () => {
    expect(summarizeLedger([])).toEqual({ skipped: 0, degraded: 0 });
  });
});
