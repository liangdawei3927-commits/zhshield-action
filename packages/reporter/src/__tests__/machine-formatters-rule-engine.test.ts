import { describe, it, expect } from 'vitest';
import { buildFindings } from '../machine-formatters';

// RuleEngineReport（SOP 驱动模式）→ Finding 的归一：
// source 由 targetEngine 决定（决定 CI 面板归属），failed 无明细时的消息回落
// 决定开发者能否在面板上看懂失败原因——这些回落路径没有兜底测试极易在重构中丢失。

/** RuleEngineReport 最小形态（类型守卫需 evaluations 数组 + ok 布尔） */
function makeRuleEngineReport(evaluations: unknown[], ok = false) {
  return {
    total: evaluations.length,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    ok,
    evaluations,
    durationMs: 5,
    timestamp: new Date(),
  };
}

function failedEvaluation(overrides: Record<string, unknown>) {
  return {
    rule: { id: 'guard.block.r1', name: '规则一' },
    status: 'failed',
    durationMs: 3,
    targetEngine: 'guard',
    timestamp: new Date(),
    ...overrides,
  };
}

describe('buildFindings — RuleEngineReport 归一', () => {
  it('failed 评估带 violations 时逐条展开，severity 归一且保留位置', () => {
    const report = makeRuleEngineReport([
      failedEvaluation({
        message: '发现 2 处匹配',
        violations: [
          { ruleId: 'secret.key', severity: 'critical', message: 'API Key', file: 'src/a.ts', line: 5, column: 1 },
          { ruleId: 'secret.key', severity: 'medium', message: '弱密码', file: 'src/b.ts', line: 9 },
        ],
      }),
    ]);

    const findings = buildFindings(report);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ ruleId: 'secret.key', severity: 'error', file: 'src/a.ts', line: 5, source: 'guard' });
    expect(findings[1].severity).toBe('warning');
  });

  it('violation 缺失 ruleId 时回落到所属规则的 id——面板按 ruleId 聚合，空值会让结果无处归属', () => {
    const report = makeRuleEngineReport([
      failedEvaluation({
        violations: [{ severity: 'error', message: '无规则号违规', file: 'a.ts' }],
      }),
    ]);

    expect(buildFindings(report)[0].ruleId).toBe('guard.block.r1');
  });

  it('failed 无 violations 时产出单条 error finding，message 回落到 `${status}: ${规则名}`——面板不能只剩一个裸状态', () => {
    const report = makeRuleEngineReport([failedEvaluation({ message: undefined })]);

    const findings = buildFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toBe('failed: 规则一');
  });

  it('failed 评估有 message 时优先使用 message', () => {
    const report = makeRuleEngineReport([failedEvaluation({ message: 'gitleaks 退出码非零' })]);
    expect(buildFindings(report)[0].message).toBe('gitleaks 退出码非零');
  });

  it('source 由 targetEngine 决定：inspect→inspect，guard/其他→guard——决定 CI 面板归属与告警路由', () => {
    const report = makeRuleEngineReport([
      failedEvaluation({ rule: { id: 'inspect.scan.r', name: '巡检规则' }, targetEngine: 'inspect' }),
      failedEvaluation({ rule: { id: 'guard.block.r', name: '门禁规则' }, targetEngine: 'guard' }),
    ]);

    const findings = buildFindings(report);
    expect(findings.map((f) => f.source)).toEqual(['inspect', 'guard']);
  });

  it('rule 缺失时 ruleId 回落 unknown——引擎数据残缺不得让归一抛异常', () => {
    const report = makeRuleEngineReport([failedEvaluation({ rule: undefined, message: 'm' })]);
    const findings = buildFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('unknown');
  });

  it('passed 评估与非降级 skipped 评估均不产出 finding——通过不产噪声，预期裁剪不算异常', () => {
    const report = makeRuleEngineReport([
      { rule: { id: 'r.pass', name: '通过' }, status: 'passed', durationMs: 1, targetEngine: 'guard', timestamp: new Date() },
      { rule: { id: 'r.scope', name: '被裁剪' }, status: 'skipped', durationMs: 0, targetEngine: 'inspect', timestamp: new Date() },
    ]);
    expect(buildFindings(report)).toHaveLength(0);
  });

  it('空 evaluations 且 ok=true 返回空数组', () => {
    expect(buildFindings(makeRuleEngineReport([], true))).toHaveLength(0);
  });
});
