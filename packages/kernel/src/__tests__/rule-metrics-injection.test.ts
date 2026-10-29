import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import type { RuleMetricsProvider } from '../runner/evaluator-host';
import { makeRule } from './helpers/rule-factory';

/**
 * threshold 指令的度量注入链路。
 *
 * 守的是 2026-10-29 之前的形态：`evalThreshold` 恒返回 passed，面板显示「通过」，
 * 实际一次比较都没做过。现在缺度量必须落 degraded skipped，有度量必须真比较。
 */
describe('SopRuleEngine — threshold 度量注入', () => {
  let registry: SopRegistry;
  let tempDir: string;

  beforeEach(() => {
    registry = new SopRegistry();
    tempDir = mkdtempSync(path.join(tmpdir(), 'rule-metrics-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const registerComplexityRule = (thresholds: Record<string, number>) => {
    registry.register(
      makeRule({
        id: 'inspect.scan.official.complexity',
        domain: 'inspect',
        action: 'scan',
        applicableEngines: ['inspect'],
        content: { thresholds },
      }),
    );
  };

  const evaluate = (provider?: RuleMetricsProvider, domain: 'guard' | 'inspect' = 'inspect') => {
    const engine = new SopRuleEngine(registry, provider ? { metricsProvider: provider } : {});
    return engine.evaluateRules({ repoRoot: tempDir, domain });
  };

  it('GIVEN 实测值超过阈值 WHEN 评估 THEN failed 且违规里带实际值与阈值', async () => {
    registerComplexityRule({ nestingDepth: 4 });

    const report = await evaluate(() => ({ metrics: { nestingDepth: 6 } }));

    expect(report.evaluations[0].status).toBe('failed');
    const violation = report.evaluations[0].violations![0];
    expect(violation.message).toContain('nestingDepth=6');
    expect(violation.message).toContain('超过阈值 4');
  });

  it('GIVEN 实测值未超阈值 WHEN 评估 THEN passed', async () => {
    registerComplexityRule({ nestingDepth: 4 });

    const report = await evaluate(() => ({ metrics: { nestingDepth: 2 } }));

    expect(report.evaluations[0].status).toBe('passed');
    expect(report.evaluations[0].degraded).toBeUndefined();
  });

  it('GIVEN 无度量提供者 WHEN 评估 THEN 落 degraded skipped（未检测 ≠ 通过）', async () => {
    registerComplexityRule({ nestingDepth: 4 });

    const report = await evaluate();

    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].degraded).toBe(true);
    expect(report.evaluations[0].message).toContain('缺少度量数据源');
    // 关键：不能因为「没数据」就判整体 ok
    expect(report.ok).toBe(false);
  });

  it('GIVEN 提供者抛错 WHEN 评估 THEN 降级文案点明是数据源异常而非缺实现', async () => {
    registerComplexityRule({ nestingDepth: 4 });

    const report = await evaluate(() => {
      throw new Error('AST 解析炸了');
    });

    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].degraded).toBe(true);
    expect(report.evaluations[0].message).toContain('度量数据源异常');
    expect(report.evaluations[0].message).toContain('AST 解析炸了');
  });

  it('GIVEN 提供者声明口径不可满足 WHEN 评估 THEN 降级文案透出该原因', async () => {
    registry.register(
      makeRule({
        id: 'guard.block.official.test-coverage',
        domain: 'guard',
        action: 'block',
        content: { threshold: 80, unit: 'percent', scope: 'diff' },
      }),
    );

    const report = await evaluate(
      () => ({ unavailableReason: '规则声明 scope=diff，而只能读到全量覆盖率' }),
      'guard',
    );

    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].degraded).toBe(true);
    expect(report.evaluations[0].message).toContain('scope=diff');
  });

  it('GIVEN 两条规则各自不同的指标值 WHEN 并行评估 THEN 结论互不串扰', async () => {
    // 同一份 context 被并行 worker 共享：若 provider 结果写回 context.extra 而非副本，
    // 先算完的那条会把值留给后一条 —— 此用例锁住「注入必须走上下文副本」。
    // unit=score 为下限型：A 的 90 ≥ 70 达标，B 的 30 < 50 未达标。
    // 若发生串扰，两条会读到同一个数，结论必然同向。
    registry.register(
      makeRule({
        id: 'guard.block.official.health-score',
        domain: 'guard',
        action: 'block',
        content: { threshold: 70, unit: 'score' },
      }),
    );
    registry.register(
      makeRule({
        id: 'guard.block.official.another-score',
        domain: 'guard',
        action: 'block',
        content: { threshold: 50, unit: 'score' },
      }),
    );

    const engine = new SopRuleEngine(registry, {
      metricsProvider: (rule) => ({
        metrics: { value: rule.id.includes('another') ? 30 : 90 },
      }),
    });
    const report = await engine.evaluateRules({ repoRoot: tempDir, domain: 'guard' });

    const health = report.evaluations.find((e) => e.rule.id.includes('health'))!;
    const another = report.evaluations.find((e) => e.rule.id.includes('another'))!;
    expect(health.status).toBe('passed');
    expect(another.status).toBe('failed');
    expect(another.violations![0].message).toContain('阈值指标=30');
  });

  it('GIVEN 非 threshold 规则 WHEN 评估 THEN 不触发度量提供者', async () => {
    let called = 0;
    registry.register(
      makeRule({
        id: 'guard.block.simple-pattern',
        domain: 'guard',
        action: 'block',
        content: { patterns: ['NOTHING_MATCHES_THIS'] },
      }),
    );

    await evaluate(() => {
      called += 1;
      return { metrics: {} };
    });

    expect(called).toBe(0);
  });

  it('GIVEN 提供者只给出部分指标 WHEN 评估 THEN 整条判未执行（不拿半份数据下结论）', async () => {
    registerComplexityRule({ nestingDepth: 4, fileLength: 300 });

    const report = await evaluate(() => ({ metrics: { nestingDepth: 2 } }));

    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].degraded).toBe(true);
    expect(report.evaluations[0].message).toContain('fileLength');
  });
});
