import { describe, it, expect } from 'vitest';
import { SopReportMapper } from '../sop-report-mapper';
import type { RuleEngineReport, RuleEvaluation } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';

// 复查4 P1 回归门禁：buildAdapterResults 此前只搬 7 个字段，
// degraded 与跳过原因（message）全部丢失 → JSON 报告里 skipped 项无任何解释，
// CLI 默认路径护栏也因此拿不到降级信号。本文件守住「字段必须透传」这一约束。

function rule(id: string): SopRule {
  return {
    id,
    name: `规则-${id}`,
    domain: 'inspect',
    action: 'scan',
    source: 'builtin',
    description: '',
    status: 'active',
    executionMode: 'blocking',
  } as unknown as SopRule;
}

function evaluation(partial: Partial<RuleEvaluation> & { rule: SopRule }): RuleEvaluation {
  return {
    status: 'passed',
    durationMs: 1,
    targetEngine: 'inspect',
    timestamp: new Date(),
    ...partial,
  } as RuleEvaluation;
}

function report(evaluations: RuleEvaluation[]): RuleEngineReport {
  return {
    total: evaluations.length,
    passed: evaluations.filter((e) => e.status === 'passed').length,
    failed: evaluations.filter((e) => e.status === 'failed').length,
    errors: evaluations.filter((e) => e.status === 'error').length,
    skipped: evaluations.filter((e) => e.status === 'skipped').length,
    ok: true,
    degraded: evaluations.filter((e) => e.degraded === true).length,
    evaluations,
    durationMs: 10,
    timestamp: new Date(),
  };
}

describe('SopReportMapper.buildAdapterResults — degraded/跳过原因透传（复查4 P1）', () => {
  const mapper = new SopReportMapper();

  it('Given 降级跳过的评估（工具不可用），When 映射为 AdapterResult，Then degraded=true 且 skipReason=degraded 且 skipDetail=原因', () => {
    const r = report([
      evaluation({
        rule: rule('inspect.scan.typescript.type-error-check'),
        status: 'skipped',
        degraded: true,
        message: 'tsc 不可用: 未找到 TypeScript 编译器',
      }),
    ]);
    const [adapter] = mapper.buildAdapterResults(r);
    expect(adapter.status).toBe('skipped');
    expect(adapter.degraded).toBe(true);
    expect(adapter.skipReason).toBe('degraded');
    expect(adapter.skipDetail).toBe('tsc 不可用: 未找到 TypeScript 编译器');
    expect(adapter.passed).toBe(false);
  });

  it('Given 预期裁剪跳过（画像 out-of-scope），When 映射，Then degraded=false 且 skipReason=out-of-scope', () => {
    const r = report([
      evaluation({
        rule: rule('inspect.scan.python.lint'),
        status: 'skipped',
        degraded: false,
      }),
    ]);
    const [adapter] = mapper.buildAdapterResults(r);
    expect(adapter.degraded).toBe(false);
    expect(adapter.skipReason).toBe('out-of-scope');
    expect(adapter.skipDetail).toBeUndefined();
  });

  it('Given 通过/失败的评估，When 映射，Then 不携带 skipReason 且 degraded 如实为 false', () => {
    const r = report([
      evaluation({ rule: rule('a'), status: 'passed' }),
      evaluation({ rule: rule('b'), status: 'failed', violations: [] }),
    ]);
    const adapters = mapper.buildAdapterResults(r);
    expect(adapters.map((a) => a.skipReason)).toEqual([undefined, undefined]);
    expect(adapters.every((a) => a.degraded === false)).toBe(true);
  });

  it('Given 混合评估（2 降级 + 3 其他），When 求顶层 degraded，Then 计数 = 2（CLI 护栏输入）', () => {
    const r = report([
      evaluation({ rule: rule('a'), status: 'skipped', degraded: true, message: 'x' }),
      evaluation({ rule: rule('b'), status: 'skipped', degraded: true, message: 'y' }),
      evaluation({ rule: rule('c'), status: 'passed' }),
      evaluation({ rule: rule('d'), status: 'skipped', degraded: false }),
      evaluation({ rule: rule('e'), status: 'failed', violations: [] }),
    ]);
    const adapters = mapper.buildAdapterResults(r);
    expect(adapters.filter((a) => a.degraded === true)).toHaveLength(2);
  });
});

describe('SopReportMapper.mergeReports — degraded 计数合并', () => {
  const mapper = new SopReportMapper();

  it('Given inspect 域 1 降级 + security 域 2 降级，When 合并，Then degraded = 3', () => {
    const inspect = report([
      evaluation({ rule: rule('i1'), status: 'skipped', degraded: true }),
      evaluation({ rule: rule('i2'), status: 'passed' }),
    ]);
    const security = report([
      evaluation({ rule: rule('s1'), status: 'skipped', degraded: true }),
      evaluation({ rule: rule('s2'), status: 'skipped', degraded: true }),
      evaluation({ rule: rule('s3'), status: 'passed' }),
    ]);
    expect(mapper.mergeReports(inspect, security).degraded).toBe(3);
  });
});
