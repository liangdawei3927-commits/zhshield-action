import { describe, it, expect } from 'vitest';
import { ScanReportBuilder } from '../scan-report-builder';
import { DegradationManager, NOOP_EMITTER } from '@zh/shared';
import type { AdapterResult, AdapterResultStatus } from '../types';
import type { Issue } from '@zh/shared';

// 复查4 P0 配套：InspectionReport 顶层 degraded 计数——
// CLI 护栏与机器可读报告的直接信号源。

function adapter(id: string, degraded: boolean): AdapterResult {
  return {
    adapterId: id,
    adapterName: id,
    duration: 0,
    issueCount: 0,
    passed: !degraded,
    degraded,
    status: degraded ? 'skipped' : 'passed',
    issues: [],
  };
}

/** 执行报错（跑了但没跑成）的适配器：degraded 为 false，零结果——曾被门禁漏计 */
function erroredAdapter(id: string): AdapterResult {
  return {
    adapterId: id,
    adapterName: id,
    duration: 0,
    issueCount: 0,
    passed: false,
    degraded: false,
    status: 'error',
    errorDetail: `${id} 执行失败`,
    issues: [],
  };
}

describe('ScanReportBuilder.buildReport — 顶层 degraded 计数', () => {
  const builder = new ScanReportBuilder(NOOP_EMITTER, new DegradationManager());

  it('Given 2 个降级跳过 + 2 个正常，Then report.degraded = 2', () => {
    const report = builder.buildReport({
      projectId: 'p',
      scanType: 'full',
      duration: 1,
      issues: [],
      adapterResults: [
        adapter('a', true),
        adapter('b', false),
        adapter('c', true),
        adapter('d', false),
      ],
    });
    expect(report.degraded).toBe(2);
  });

  it('Given 无降级，Then report.degraded = 0（字段恒写入，不缺省）', () => {
    const report = builder.buildReport({
      projectId: 'p',
      scanType: 'full',
      duration: 1,
      issues: [],
      adapterResults: [adapter('a', false)],
    });
    expect(report.degraded).toBe(0);
  });

  it('Given 1 个降级跳过 + 1 个执行报错，Then report.degraded = 2（跑挂同样计入未执行）', () => {
    const report = builder.buildReport({
      projectId: 'p',
      scanType: 'full',
      duration: 1,
      issues: [],
      adapterResults: [adapter('a', true), erroredAdapter('b')],
    });
    expect(report.degraded).toBe(2);
  });

  it('Given 仅 1 个执行报错且无降级，Then report.degraded = 1', () => {
    const report = builder.buildReport({
      projectId: 'p',
      scanType: 'full',
      duration: 1,
      issues: [],
      adapterResults: [adapter('a', false), erroredAdapter('b')],
    });
    expect(report.degraded).toBe(1);
  });
});

/**
 * P0（2026-10-04）：scoreOf 对零问题直接给 100，而"零问题"最常见的成因恰恰是
 * 工具没跑成（error/unavailable/issues 恒为空）。于是覆盖率越低分数越高——
 * 实测 11 个适配器里 7 个未执行时仍报 overall=100 / grade A，
 * 与 CLI 自己的原则"未检测不计为通过"自相矛盾。
 * 修法：按覆盖率给 overall 封顶，并让 grade 跟随封顶后的分数重算。
 */
function adapterWithStatus(
  id: string,
  status: AdapterResultStatus,
  extra: { degraded?: boolean; skipReason?: 'degraded' | 'out-of-scope' } = {},
): AdapterResult {
  return {
    adapterId: id,
    adapterName: id,
    duration: 0,
    issueCount: 0,
    passed: status === 'passed',
    degraded: extra.degraded ?? false,
    status,
    skipReason: extra.skipReason,
    issues: [],
  };
}

function errorIssue(): Issue {
  return {
    id: 'i-1',
    ruleId: 'r-1',
    severity: 'error',
    category: 'quality',
    message: 'boom',
    file: 'src/a.ts',
    autoFixable: false,
    source: 'inspect',
    fingerprint: 'fp-1',
  };
}

describe('ScanReportBuilder.buildReport — 覆盖率封顶（未检测不得刷满分）', () => {
  const builder = new ScanReportBuilder(NOOP_EMITTER, new DegradationManager());
  const build = (adapterResults: AdapterResult[], issues: Issue[] = []) =>
    builder.buildReport({
      projectId: 'p',
      scanType: 'full',
      duration: 1,
      issues,
      adapterResults,
    });

  it('Given 完全无适配器（零检查），Then overall 不得为满分', () => {
    const report = build([]);
    expect(report.coverage).toBe(0);
    expect(report.score.overall).toBeLessThan(100);
  });

  it('Given 全部工具未执行且零问题，Then overall 不得为满分', () => {
    const report = build([
      adapterWithStatus('a', 'error'),
      adapterWithStatus('b', 'unavailable'),
      adapterWithStatus('c', 'skipped', { degraded: true }),
    ]);
    expect(report.coverage).toBe(0);
    expect(report.score.overall).toBeLessThan(100);
  });

  it('Given 覆盖率 36%（4/11），Then overall 封顶 59 且等级为 D', () => {
    const report = build([
      ...Array.from({ length: 4 }, (_, i) => adapterWithStatus(`ok${i}`, 'passed')),
      ...Array.from({ length: 7 }, (_, i) => adapterWithStatus(`bad${i}`, 'error')),
    ]);
    expect(report.coverage).toBeCloseTo(4 / 11, 5);
    expect(report.score.overall).toBe(59);
    expect(report.score.grade).toMatch(/^D/);
  });

  it('Given 覆盖率 72.7%（8/11），Then overall 封顶 74（至多 C）', () => {
    const report = build([
      ...Array.from({ length: 8 }, (_, i) => adapterWithStatus(`ok${i}`, 'passed')),
      ...Array.from({ length: 3 }, (_, i) => adapterWithStatus(`bad${i}`, 'unavailable')),
    ]);
    expect(report.coverage).toBeCloseTo(8 / 11, 5);
    expect(report.score.overall).toBe(74);
    expect(report.score.grade).toMatch(/^C/);
  });

  it('Given 覆盖率 100%，Then 不封顶，问题分照常（1 error → 90/A）', () => {
    const report = build(
      [adapterWithStatus('a', 'passed'), adapterWithStatus('b', 'failed')],
      [errorIssue()],
    );
    expect(report.coverage).toBe(1);
    expect(report.score.overall).toBe(90);
    expect(report.score.grade).toMatch(/^A/);
  });

  it('Given out-of-scope 跳过，Then 不计入覆盖率分母（不视为未执行）', () => {
    const report = build([
      adapterWithStatus('a', 'passed'),
      adapterWithStatus('b', 'passed'),
      adapterWithStatus('c', 'skipped', { skipReason: 'out-of-scope' }),
    ]);
    expect(report.coverage).toBe(1);
    expect(report.degraded).toBe(0);
    expect(report.score.overall).toBe(100);
  });

  it('Then grade 必须与封顶后的 overall 一致（不得出现 overall=59 却 grade A）', () => {
    const report = build([adapterWithStatus('a', 'error')]);
    expect(report.score.overall).toBe(59);
    expect(report.score.grade).toMatch(/^D/);
  });

  it('Given 全部通过且满覆盖，Then grade 后缀不出现（无降级即无后缀）', () => {
    const report = build([adapterWithStatus('a', 'passed')]);
    expect(report.score.grade).toBe('A');
  });
});
