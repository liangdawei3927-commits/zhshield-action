import { describe, it, expect } from 'vitest';
import { ScanReportBuilder } from '../scan-report-builder';
import { DegradationManager, NOOP_EMITTER } from '@zh/shared';
import type { AdapterResult } from '../types';

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
});
