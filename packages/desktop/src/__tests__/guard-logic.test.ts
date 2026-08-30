import { describe, expect, it } from 'vitest';
import { toGuardReportDataFromRecord, buildGuardLevels, deriveGuardStatus } from '../pages/guard-logic';

describe('toGuardReportDataFromRecord 恢复映射', () => {
  it('maps summary fields to page report shape', () => {
    const report = toGuardReportDataFromRecord({
      timestamp: '2026-08-06T08:00:00.000Z',
      triggerSource: 'manual',
      ok: false,
      riskLevel: 'high',
      summary: { total: 4, passed: 1, failed: 1, warnings: 1, blocking: 2, errors: 1 },
      checks: [],
    });

    expect(report.summary).toEqual({ totalChecks: 4, passed: 1, blocked: 2, warnings: 1 });
    expect(report.metadata.timestamp).toBe('2026-08-06T08:00:00.000Z');
  });

  it('maps check status and severity like engine toGuardReportData', () => {
    const report = toGuardReportDataFromRecord({
      timestamp: 't',
      triggerSource: 'manual',
      ok: null,
      riskLevel: 'medium',
      summary: { total: 3, passed: 0, failed: 0, warnings: 0, blocking: 0, errors: 0 },
      checks: [
        { checkId: 'eslint-error', adapter: 'eslint', status: 'passed', severity: 'error', blocking: true, message: 'ok now' },
        { checkId: 'ts-error', adapter: 'tsc', status: 'failed', severity: 'error', blocking: true, message: 'type broken' },
        { checkId: 'warn-rule', adapter: 'guard', status: 'warning', severity: 'warning', blocking: false, message: 'heuristic' },
        { checkId: 'info-rule', adapter: 'guard', status: 'error', severity: 'info', blocking: false, message: 'info only' },
      ],
    });

    expect(report.checks).toEqual([
      { id: 'eslint-error', name: 'eslint-error', status: 'pass', message: 'ok now', severity: 'high' },
      { id: 'ts-error', name: 'ts-error', status: 'fail', message: 'type broken', severity: 'high' },
      { id: 'warn-rule', name: 'warn-rule', status: 'warn', message: 'heuristic', severity: 'medium' },
      { id: 'info-rule', name: 'info-rule', status: 'fail', message: 'info only', severity: 'low' },
    ]);
  });
});

describe('buildGuardLevels 三级拦截关卡聚合', () => {
  it('idle 状态：无历史记录时三关均未触发', () => {
    const levels = buildGuardLevels([]);
    expect(levels).toHaveLength(3);
    expect(levels.every((l) => l.status === 'idle' && l.blockingCount === 0)).toBe(true);
  });

  it('三关统一由全局最近一次扫描驱动：不复用 triggerSource 过滤、不累加历史', () => {
    const levels = buildGuardLevels([
      { timestamp: '2026-08-07T08:00:00.000Z', triggerSource: 'pre-commit', ok: false, riskLevel: 'high', summary: { total: 3, passed: 1, failed: 2, warnings: 0, blocking: 2, errors: 0 }, checks: [] },
      { timestamp: '2026-08-07T09:00:00.000Z', triggerSource: 'pre-commit', ok: true, riskLevel: 'low', summary: { total: 2, passed: 2, failed: 0, warnings: 0, blocking: 0, errors: 0 }, checks: [] },
      { timestamp: '2026-08-07T10:00:00.000Z', triggerSource: 'pre-push', ok: false, riskLevel: 'medium', summary: { total: 4, passed: 3, failed: 0, warnings: 1, blocking: 1, errors: 0 }, checks: [] },
      { timestamp: '2026-08-07T11:00:00.000Z', triggerSource: 'manual', ok: true, riskLevel: 'low', summary: { total: 1, passed: 1, failed: 0, warnings: 0, blocking: 0, errors: 0 }, checks: [] },
    ]);

    const l1 = levels.find((l) => l.level === 'L1')!;
    const l2 = levels.find((l) => l.level === 'L2')!;
    const l3 = levels.find((l) => l.level === 'L3')!;

    // 全局最近一次是 manual 11:00（通过）→ 三关一致为 pass / 0 / 该时间
    expect(l1.status).toBe('pass');
    expect(l1.blockingCount).toBe(0);
    expect(l1.lastAt).toBe('2026-08-07T11:00:00.000Z');
    expect(l2.status).toBe('pass');
    expect(l2.blockingCount).toBe(0);
    expect(l2.lastAt).toBe('2026-08-07T11:00:00.000Z');
    expect(l3.status).toBe('pass');
    expect(l3.blockingCount).toBe(0);
    expect(l3.lastAt).toBe('2026-08-07T11:00:00.000Z');
  });

  it('最近一次记录含警告 → 三关 warn，blockingCount 取该次 blocking 而非累加', () => {
    const levels = buildGuardLevels([
      { timestamp: '2026-08-07T08:00:00.000Z', triggerSource: 'pre-commit', ok: true, riskLevel: 'low', summary: { total: 1, passed: 1, failed: 0, warnings: 0, blocking: 1, errors: 0 }, checks: [] },
      { timestamp: '2026-08-07T09:00:00.000Z', triggerSource: 'manual', ok: true, riskLevel: 'low', summary: { total: 1, passed: 1, failed: 0, warnings: 1, blocking: 0, errors: 1 }, checks: [] },
    ]);

    const l1 = levels.find((l) => l.level === 'L1')!;
    expect(l1.status).toBe('warn');
    expect(l1.blockingCount).toBe(0);
    expect(l1.lastAt).toBe('2026-08-07T09:00:00.000Z');
  });
});

describe('deriveGuardStatus 门禁整体状态', () => {
  it('任一关卡拦截 → fail', () => {
    const levels = [
      { level: 'L1' as const, label: '提交门禁', triggerSource: 'pre-commit', status: 'fail' as const, blockingCount: 1, lastAt: 't' },
      { level: 'L2' as const, label: '推送门禁', triggerSource: 'pre-push', status: 'pass' as const, blockingCount: 0, lastAt: 't' },
      { level: 'L3' as const, label: 'CI 门禁', triggerSource: 'ci', status: 'idle' as const, blockingCount: 0, lastAt: null },
    ];
    expect(deriveGuardStatus(levels)).toEqual({ status: 'fail', label: '门禁拦截' });
  });

  it('无拦截但有警告 → warn', () => {
    const levels = [
      { level: 'L1' as const, label: '提交门禁', triggerSource: 'pre-commit', status: 'warn' as const, blockingCount: 0, lastAt: 't' },
      { level: 'L2' as const, label: '推送门禁', triggerSource: 'pre-push', status: 'pass' as const, blockingCount: 0, lastAt: 't' },
      { level: 'L3' as const, label: 'CI 门禁', triggerSource: 'ci', status: 'idle' as const, blockingCount: 0, lastAt: null },
    ];
    expect(deriveGuardStatus(levels).status).toBe('warn');
  });

  it('全空闲 → pass 守护中', () => {
    const levels = [
      { level: 'L1' as const, label: '提交门禁', triggerSource: 'pre-commit', status: 'idle' as const, blockingCount: 0, lastAt: null },
      { level: 'L2' as const, label: '推送门禁', triggerSource: 'pre-push', status: 'idle' as const, blockingCount: 0, lastAt: null },
      { level: 'L3' as const, label: 'CI 门禁', triggerSource: 'ci', status: 'idle' as const, blockingCount: 0, lastAt: null },
    ];
    expect(deriveGuardStatus(levels)).toEqual({ status: 'pass', label: '守护中' });
  });
});
