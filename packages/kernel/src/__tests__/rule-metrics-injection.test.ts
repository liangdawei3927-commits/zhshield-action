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
    // 注意：不能用 test-coverage / health-score 这类后置门禁规则来测这条路径，
    // 它们已在 evalThreshold 入口让位（不向度量源要数）。此处用普通阈值规则。
    registry.register(
      makeRule({
        id: 'inspect.scan.custom-metric',
        domain: 'inspect',
        action: 'scan',
        content: { thresholds: { customMetric: 80 } },
      }),
    );

    const report = await evaluate(
      () => ({ unavailableReason: '该指标口径未实现，无法取数' }),
      'inspect',
    );

    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].degraded).toBe(true);
    expect(report.evaluations[0].message).toContain('口径未实现');
  });

  it('GIVEN 两条规则各自不同的指标值 WHEN 并行评估 THEN 结论互不串扰', async () => {
    // 同一份 context 被并行 worker 共享：若 provider 结果写回 context.extra 而非副本，
    // 先算完的那条会把值留给后一条 —— 此用例锁住「注入必须走上下文副本」。
    // unit=score 为下限型：A 的 90 ≥ 70 达标，B 的 30 < 50 未达标。
    // 若发生串扰，两条会读到同一个数，结论必然同向。
    registry.register(
      makeRule({
        id: 'guard.block.custom-score-a',
        domain: 'guard',
        action: 'block',
        content: { threshold: 70, unit: 'score' },
      }),
    );
    registry.register(
      makeRule({
        id: 'guard.block.custom-score-b',
        domain: 'guard',
        action: 'block',
        content: { threshold: 50, unit: 'score' },
      }),
    );

    const engine = new SopRuleEngine(registry, {
      metricsProvider: (rule) => ({
        metrics: { value: rule.id.includes('score-b') ? 30 : 90 },
      }),
    });
    const report = await engine.evaluateRules({ repoRoot: tempDir, domain: 'guard' });

    const scoreA = report.evaluations.find((e) => e.rule.id.endsWith('score-a'))!;
    const scoreB = report.evaluations.find((e) => e.rule.id.endsWith('score-b'))!;
    expect(scoreA.status).toBe('passed');
    expect(scoreB.status).toBe('failed');
    expect(scoreB.violations![0].message).toContain('阈值指标=30');
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

  it('GIVEN 后置门禁规则（健康分/覆盖率）WHEN 评估 THEN 让位不降级，ok 不受拖累', async () => {
    // 聚合分与覆盖率在扫描过程中必然拿不到。若仍走 evalThreshold 的缺值分支，
    // 每次体检都会固定背 3 条降级 ⇒ ok 恒 false、门禁红灯变噪音。
    // 正确语义：引擎显式让位（skipped 但 degraded=false），判定由 gate 阶段完成。
    registry.register(
      makeRule({
        id: 'guard.block.official.health-score',
        domain: 'guard',
        action: 'block',
        content: { threshold: 70, unit: 'score' },
      }),
    );

    let providerCalled = 0;
    const report = await evaluate(() => {
      providerCalled += 1;
      return { metrics: {} };
    }, 'guard');

    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].degraded).toBeUndefined();
    expect(report.evaluations[0].message).toContain('后置门禁');
    // 让位不等于放弃：不能再向度量源要数据，也不该拖累 ok
    expect(providerCalled).toBe(0);
    expect(report.ok).toBe(true);
  });
});
