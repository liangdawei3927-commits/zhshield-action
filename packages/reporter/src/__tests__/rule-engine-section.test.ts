import { describe, it, expect } from 'vitest';
import { RuleEngineSectionFormatter } from '../console-reporter-rule-engine';
import { tallyViolationsByCategory } from '../rule-engine-formatter';
import { ConsoleReporterFormat } from '../console-reporter-format';
import type { RuleEngineReport, RuleEvaluation } from '@zh/kernel';

// RuleEngineSectionFormatter 渲染 SOP 引擎报告的终端视图。
// 降级计数的可见性（「降级: N」列）是盲检治理的一环：规则被降级跳过时
// 用户必须在汇总行看到它，而不是在「通过」的假象里被蒙混过关。

function makeRule(id: string) {
  return {
    id,
    name: id,
    domain: 'guard',
    action: 'scan',
    source: 'official',
    description: '',
    status: 'active' as const,
    executionMode: 'sync' as const,
    severity: 'medium',
    applicableEngines: ['guard'],
    content: {},
    tags: [],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeEvaluation(overrides: Partial<RuleEvaluation>): RuleEvaluation {
  return {
    rule: makeRule('test-rule'),
    status: 'passed',
    durationMs: 5,
    targetEngine: 'guard',
    timestamp: new Date(),
    ...overrides,
  } as RuleEvaluation;
}

function makeReport(evaluations: RuleEvaluation[], counts: Partial<RuleEngineReport> = {}): RuleEngineReport {
  return {
    total: evaluations.length,
    passed: evaluations.filter((e) => e.status === 'passed').length,
    failed: evaluations.filter((e) => e.status === 'failed').length,
    errors: evaluations.filter((e) => e.status === 'error').length,
    skipped: evaluations.filter((e) => e.status === 'skipped').length,
    ok: true,
    evaluations,
    durationMs: 10,
    timestamp: new Date(),
    ...counts,
  } as RuleEngineReport;
}

function formatText(report: RuleEngineReport): string {
  const formatter = new RuleEngineSectionFormatter(new ConsoleReporterFormat(false));
  const lines: string[] = [];
  formatter.format(report, lines, '');
  return lines.join('\n');
}

describe('RuleEngineSectionFormatter — SOP 引擎报告终端渲染', () => {
  it('汇总行包含通过/失败/错误/跳过四档计数——用户依据四档分布判断引擎健康度', () => {
    const report = makeReport(
      [
        makeEvaluation({ rule: makeRule('r.pass'), status: 'passed' }),
        makeEvaluation({ rule: makeRule('r.fail'), status: 'failed', message: '失败' }),
        makeEvaluation({ rule: makeRule('r.err'), status: 'error', message: '错误' }),
        makeEvaluation({ rule: makeRule('r.skip'), status: 'skipped', message: '跳过' }),
      ],
      { ok: false },
    );

    const text = formatText(report);
    expect(text).toContain('汇总');
    expect(text).toContain('4 条规则');
    expect(text).toContain('通过: 1');
    expect(text).toContain('失败: 1');
    expect(text).toContain('错误: 1');
    expect(text).toContain('跳过: 1');
  });

  it('degraded>0 时汇总行必须出现「降级: N」列——盲检被降级跳过不得隐身于汇总', () => {
    const text = formatText(makeReport([], { degraded: 3 }));
    expect(text).toContain('降级: 3');
  });

  it('degraded 为 0/缺省时不输出降级列——避免正常路径出现永远为 0 的噪音列', () => {
    expect(formatText(makeReport([]))).not.toContain('降级');
    expect(formatText(makeReport([], { degraded: 0 }))).not.toContain('降级');
  });

  it('total=0 时输出「无匹配规则」并提前返回——空规则集与「全部通过」必须区分呈现', () => {
    const text = formatText(makeReport([]));
    expect(text).toContain('无匹配规则');
    expect(text).not.toContain('通过规则');
  });

  it('四类状态各自归入对应分组：失败/错误/跳过/通过', () => {
    const text = formatText(
      makeReport([
        makeEvaluation({ rule: makeRule('r.fail'), status: 'failed' }),
        makeEvaluation({ rule: makeRule('r.err'), status: 'error', message: '超时' }),
        makeEvaluation({ rule: makeRule('r.skip'), status: 'skipped', message: '工具缺失' }),
        makeEvaluation({ rule: makeRule('r.pass'), status: 'passed' }),
      ], { ok: false }),
    );

    expect(text).toContain('失败规则:');
    expect(text).toContain('错误规则:');
    expect(text).toContain('⚠ r.err: 超时');
    expect(text).toContain('跳过规则:');
    expect(text).toContain('r.skip — 工具缺失');
    expect(text).toContain('通过规则:');
    expect(text).toContain('✓ r.pass');
  });

  it('跳过清单区分 [降级] 与 [让位]——两类后果相反，外观必须可分', () => {
    const text = formatText(
      makeReport([
        makeEvaluation({
          rule: makeRule('r.degraded'),
          status: 'skipped',
          degraded: true,
          message: '工具缺失',
        }),
        makeEvaluation({
          rule: makeRule('r.yield'),
          status: 'skipped',
          message: '后置门禁规则：由扫描后门禁阶段判定，引擎内不求值',
        }),
      ]),
    );

    expect(text).toContain('[降级] r.degraded');
    expect(text).toContain('[让位] r.yield');
    // 双向自证：让位项绝不能被标成降级 —— 那会让「刻意让位」被读成环境缺陷，
    // 用户据此去修一个不存在的故障（后置门禁两条正是这样被误报成问题的）。
    expect(text).not.toContain('[降级] r.yield');
    expect(text).not.toContain('[让位] r.degraded');
  });

  it('失败规则的违规明细展示位置/分类/建议，超出 10 条时截断并提示余量——终端视图必须有界，不得被大报告刷屏', () => {
    const violations = Array.from({ length: 13 }, (_, i) => ({
      id: `v${i}`,
      ruleId: 'r.bulk',
      severity: 'low' as const,
      file: `src/f${i}.ts`,
      line: i + 1,
      message: `问题 ${i}`,
      category: 'quality',
      suggestion: '修复它',
    }));
    const text = formatText(
      makeReport([makeEvaluation({ rule: makeRule('r.bulk'), status: 'failed', violations })], { ok: false }),
    );

    expect(text).toContain('src/f0.ts:1');
    expect(text).toContain('[quality]');
    expect(text).toContain('问题 0');
    expect(text).toContain('建议:');
    expect(text).not.toContain('src/f12.ts:13'); // 第 11 条起不展示
    expect(text).toContain('... 及另外 3 项');
  });

  it('失败评估带 files 时显示涉及文件数——规模感影响排障优先级判断', () => {
    const text = formatText(
      makeReport([
        makeEvaluation({ rule: makeRule('r.files'), status: 'failed', files: ['a.ts', 'b.ts', 'c.ts'] }),
      ], { ok: false }),
    );
    expect(text).toContain('涉及文件: 3 个');
  });
});

describe('tallyViolationsByCategory — 违规分类统计', () => {
  it('只统计 failed 评估的违规；无 category 归入 uncategorized——通过项不得计入分类噪音', () => {
    const evaluations = [
      makeEvaluation({
        rule: makeRule('r.fail'),
        status: 'failed',
        violations: [
          { id: 'v1', ruleId: 'r', severity: 'low', file: 'a.ts', message: 'm1' },
          { id: 'v2', ruleId: 'r', severity: 'low', file: 'b.ts', message: 'm2', category: 'security' },
        ],
      }),
      makeEvaluation({
        rule: makeRule('r.pass'),
        status: 'passed',
        violations: [{ id: 'v3', ruleId: 'r', severity: 'low', file: 'c.ts', message: 'm3', category: 'quality' }],
      }),
    ];

    const tally = tallyViolationsByCategory(evaluations);
    expect(tally).toEqual([
      ['uncategorized', 1],
      ['security', 1],
    ]);
  });

  it('按计数降序排列；同计数保持首次出现顺序（稳定排序）——排序抖动会让终端 diff 噪声化', () => {
    const evaluations = [
      makeEvaluation({
        rule: makeRule('r1'),
        status: 'failed',
        violations: [
          { id: 'v1', ruleId: 'r', severity: 'low', file: 'a.ts', message: 'm', category: 'alpha' },
          { id: 'v2', ruleId: 'r', severity: 'low', file: 'b.ts', message: 'm', category: 'beta' },
        ],
      }),
      makeEvaluation({
        rule: makeRule('r2'),
        status: 'failed',
        violations: [
          { id: 'v3', ruleId: 'r', severity: 'low', file: 'c.ts', message: 'm', category: 'alpha' },
          { id: 'v4', ruleId: 'r', severity: 'low', file: 'd.ts', message: 'm', category: 'gamma' },
          { id: 'v5', ruleId: 'r', severity: 'low', file: 'e.ts', message: 'm', category: 'gamma' },
        ],
      }),
    ];

    const tally = tallyViolationsByCategory(evaluations);
    // gamma 首次出现在 alpha 之后，同计数时稳定排序保持插入序
    expect(tally).toEqual([
      ['alpha', 2],
      ['gamma', 2],
      ['beta', 1],
    ]);
  });

  it('不适用单列、不计入通过——「没得查」不能被读成「查过且安全」', () => {
    const report = makeReport(
      [
        makeEvaluation({
          rule: makeRule('security.web.helmet-check'),
          applicability: 'not-applicable',
          message: 'helmet-configured: 项目未使用 Web 框架，检查不适用',
        }),
      ],
      { passed: 0, notApplicable: 1 },
    );

    const text = formatText(report);
    expect(text).toContain('不适用: 1');
    expect(text).toContain('不适用规则:');
    expect(text).toContain('security.web.helmet-check');
    // 不得同时出现在「通过规则」列表：那是两种不同结论
    expect(text).not.toContain('通过规则:');
  });
});
