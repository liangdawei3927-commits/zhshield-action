import { describe, expect, it } from 'vitest';
import { buildHealthDimensions } from '@zh/scoring';
import type { GuardReportRecord } from '@zh/guard';
import {
  assembleHealthInputs,
  qualityFastPathScore,
  type HealthInputReads,
} from '../../electron/report-summary';
import type { DashboardState } from '../../electron/ipc/dashboard-state';
import type { DiagnosticEntry, DiagnosticsReport } from '../../electron/zh-diagnostics';

/**
 * 输入组装 + 分类页实时评分 compose-on-read（2026-09-19 批 10）。
 *
 * 报告中心汇总（写分点 ②）与分类页实时评分共用 assembleHealthInputs 组装输入，
 * 两条路径结构上不可能漂移。本文件锁定：
 * ① Q4 评分输入缺口修复 —— security/deps 专用扫描发现并入（malware/license/environment 排除）；
 * ② quality 快路径透传快照自带评分 + previousScore；
 * ③ not-run 维度原样返回（渲染层回退汇总）；
 * ④ timestamps 各维度锚点来源。
 */

function entry(over: Partial<DiagnosticEntry>): DiagnosticEntry {
  return {
    ruleId: 'rule-x',
    severity: 'error',
    category: 'security',
    message: 'msg',
    file: '',
    autoFixable: false,
    source: 'security',
    fingerprint: 'fp-default',
    ...over,
  };
}

function snapshot(issues: DiagnosticEntry[], generatedAt: string): DiagnosticsReport {
  return {
    version: '1.0',
    project: { path: '/proj', name: 'proj' },
    generatedAt,
    summary: { total: issues.length, error: 0, warning: 0, info: 0 },
    issues,
    files: [],
  };
}

function makeReads(over: Partial<HealthInputReads> = {}): HealthInputReads {
  return {
    listGuardReports: () => [],
    readDomainSnapshot: async () => null,
    readDashboardState: async () => ({}),
    buildPipelineExtras: async () => ({}),
    now: () => '2026-09-19T12:00:00.000Z',
    ...over,
  };
}

describe('assembleHealthInputs：Q4 评分输入缺口修复', () => {
  it('security 快照 security 类 + deps 快照 dependency 类并入；malware/license/environment 排除', async () => {
    const securitySnap = snapshot(
      [
        entry({ category: 'security', severity: 'error', fingerprint: 's1' }),
        entry({ category: 'malware', severity: 'error', fingerprint: 'm1' }),
      ],
      '2026-09-19T10:00:00.000Z',
    );
    const depsSnap = snapshot(
      [
        entry({ category: 'dependency', severity: 'warning', fingerprint: 'd1', source: 'deps' }),
        entry({ category: 'license', severity: 'error', fingerprint: 'l1', source: 'deps' }),
        entry({ category: 'environment', severity: 'warning', fingerprint: 'e1', source: 'deps' }),
      ],
      '2026-09-19T11:00:00.000Z',
    );
    const inputs = await assembleHealthInputs('/proj', makeReads({
      readDomainSnapshot: async (_p, source) =>
        source === 'security' ? securitySnap : source === 'deps' ? depsSnap : null,
    }));

    expect(inputs.inspectIssues).toEqual([
      { severity: 'error', category: 'security' },
      { severity: 'warning', category: 'dependency' },
    ]);

    // 喂给 buildHealthDimensions：security/deps 维终于被计分（此前只读 inspect 快照 → 永远 not-run）
    const dims = buildHealthDimensions({
      guard: null,
      inspect: inputs.inspectIssues ? { issues: inputs.inspectIssues } : null,
      projectRoot: '/proj',
      extras: inputs.extras,
    });
    const security = dims.find((d) => d.name === 'security');
    const deps = dims.find((d) => d.name === 'dependencies');
    expect(security?.status).toBe('scored');
    expect(security?.score).toBe(92); // 100 - error 8
    expect(deps?.status).toBe('scored');
    expect(deps?.score).toBe(96); // 100 - warning 4
  });

  it('只跑了 security 扫描（无 inspect 快照）→ inspectIssues 非空，security 维可计分', async () => {
    const securitySnap = snapshot(
      [entry({ category: 'security', severity: 'error', fingerprint: 's1' })],
      '2026-09-19T10:00:00.000Z',
    );
    const inputs = await assembleHealthInputs('/proj', makeReads({
      readDomainSnapshot: async (_p, source) => (source === 'security' ? securitySnap : null),
    }));

    expect(inputs.inspectIssues).not.toBeNull();
    const dims = buildHealthDimensions({
      guard: null,
      inspect: inputs.inspectIssues ? { issues: inputs.inspectIssues } : null,
      projectRoot: '/proj',
      extras: inputs.extras,
    });
    expect(dims.find((d) => d.name === 'security')?.status).toBe('scored');
    expect(inputs.timestamps.security).toBe('2026-09-19T10:00:00.000Z');
  });

  it('无任何快照 → inspectIssues 为 null（各维按 not-run 处理）', async () => {
    const inputs = await assembleHealthInputs('/proj', makeReads());
    expect(inputs.inspectIssues).toBeNull();
    expect(inputs.guard).toBeNull();
  });
});

describe('quality 快路径：透传快照自带评分 + previousScore', () => {
  it('有 dimensionScore → 原样返回（含 version 与 previousScore）', () => {
    const snap = snapshot([entry({ category: 'quality' })], '2026-09-19T10:00:00.000Z');
    snap.dimensionScore = { dimension: 'quality', score: 92, issues: 1, status: 'scored', version: 2 };
    snap.previousScore = { score: 85, generatedAt: '2026-09-18T10:00:00.000Z' };
    expect(qualityFastPathScore(snap)).toEqual({
      dimension: 'quality',
      score: 92,
      issues: 1,
      status: 'scored',
      version: 2,
      generatedAt: '2026-09-19T10:00:00.000Z',
      previousScore: { score: 85, generatedAt: '2026-09-18T10:00:00.000Z' },
    });
  });

  it('无快照或无 dimensionScore（旧格式）→ null', () => {
    expect(qualityFastPathScore(null)).toBeNull();
    expect(qualityFastPathScore(snapshot([], '2026-09-19T10:00:00.000Z'))).toBeNull();
  });
});

describe('compose-on-read：not-run 维度原样返回', () => {
  it('gate 无 guard 记录 → status not-run、score 0、时间锚点 null', async () => {
    const inputs = await assembleHealthInputs('/proj', makeReads());
    const dims = buildHealthDimensions({
      guard: inputs.guard,
      inspect: inputs.inspectIssues ? { issues: inputs.inspectIssues } : null,
      projectRoot: '/proj',
      extras: inputs.extras,
    });
    const gate = dims.find((d) => d.name === 'gate');
    expect(gate?.status).toBe('not-run');
    expect(gate?.score).toBe(0);
    expect(inputs.timestamps.gate).toBeNull();
  });
});

describe('timestamps 各维度锚点来源', () => {
  it('quality=inspect.generatedAt / gate=guard.timestamp / security=max(secrets,securitySnap) / deps=max(deps,depsSnap) / 其余取 dashboard-state / sentinel+backup=now', async () => {
    const guardRecord: GuardReportRecord = {
      timestamp: '2026-09-19T09:00:00.000Z',
      triggerSource: 'manual',
      ok: true,
      riskLevel: 'low',
      summary: { total: 1, passed: 1, failed: 0, warnings: 0, blocking: 0, errors: 0 },
      checks: [
        { checkId: 'c', adapter: 'a', status: 'passed', severity: 'info', blocking: false, message: '' },
      ],
    };
    const inspectSnap = snapshot([], '2026-09-19T08:00:00.000Z');
    const securitySnap = snapshot(
      [entry({ category: 'security', fingerprint: 's1' })],
      '2026-09-19T10:30:00.000Z',
    );
    const depsSnap = snapshot(
      [entry({ category: 'dependency', source: 'deps', fingerprint: 'd1' })],
      '2026-09-19T11:30:00.000Z',
    );
    const state: DashboardState = {
      secrets: { activeCount: 1, lastRunAt: '2026-09-19T10:00:00.000Z' },
      deps: {
        vulnerabilities: { critical: 0, high: 0, medium: 0 },
        upgradable: 0,
        lastRunAt: '2026-09-19T11:00:00.000Z',
      },
      techdebt: { debtIndex: 10, issueCount: 2, lastRunAt: '2026-09-19T07:00:00.000Z' },
      refactor: {
        totalSmells: 3,
        bySeverity: { error: 0, warning: 0, info: 3 },
        lastRunAt: '2026-09-19T06:00:00.000Z',
      },
      performance: {
        total: 1,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 1 },
        lastRunAt: '2026-09-19T05:00:00.000Z',
      },
      garbage: { total: 2, byType: { 'build-artifact': 2 }, lastRunAt: '2026-09-19T04:00:00.000Z' },
    };
    const inputs = await assembleHealthInputs('/proj', makeReads({
      listGuardReports: () => [guardRecord],
      readDomainSnapshot: async (_p, source) =>
        source === 'inspect'
          ? inspectSnap
          : source === 'security'
            ? securitySnap
            : source === 'deps'
              ? depsSnap
              : null,
      readDashboardState: async () => state,
    }));

    expect(inputs.timestamps).toEqual({
      quality: '2026-09-19T08:00:00.000Z',
      gate: '2026-09-19T09:00:00.000Z',
      security: '2026-09-19T10:30:00.000Z', // max(secrets 10:00, securitySnap 10:30)
      dependencies: '2026-09-19T11:30:00.000Z', // max(deps 11:00, depsSnap 11:30)
      techdebt: '2026-09-19T07:00:00.000Z',
      refactor: '2026-09-19T06:00:00.000Z',
      performance: '2026-09-19T05:00:00.000Z',
      garbage: '2026-09-19T04:00:00.000Z',
      sentinel: '2026-09-19T12:00:00.000Z',
      backup: '2026-09-19T12:00:00.000Z',
    });
  });
});