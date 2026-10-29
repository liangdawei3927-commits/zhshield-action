import { describe, it, expect } from 'vitest';

import {
  evaluatePostScanGates,
  readGateDeclaration,
  readRuleSemantics,
  selectPostScanGates,
  formatGateItems,
  POST_SCAN_GATE_BINDINGS,
  MAPPING_RULES,
} from '../runner/post-scan-gate';
import type { GateValue } from '../runner/post-scan-gate';
import { makeRule } from './helpers/rule-factory';
import type { SopRule } from '../sop/_meta/sop-types';

/**
 * 扫描后门禁（健康分 / 质量分 / 覆盖率）的判定语义。
 *
 * 守的是 2026-10-29 实测出来的形态：云端 3 条 active 阈值规则声明的是「整轮扫描结束后
 * 才存在的数」，规则引擎在扫描过程中求值必然拿不到 ⇒ 每次体检固定背 3 条降级，`ok` 恒 false。
 * 门禁红灯一旦变成噪音，用户第一件事就是把整套 SOP 关掉。
 *
 * 本模块把它们挪到独立阶段判定。三条不可退让的语义在这里锁死：
 *   ① 有实测值就**真比较**（不是拼字符串）；
 *   ② 拿不到数 ⇒ `undetermined`，**绝不冒充 passed**；
 *   ③ `ok` 只在「全部判定完成且无一越界」时为真 —— undetermined 存在即不合格。
 */

const healthScoreRule = (threshold?: number) =>
  makeRule({
    id: 'guard.block.official.health-score',
    domain: 'guard',
    action: 'block',
    content: { ...(threshold !== undefined ? { threshold } : {}), unit: 'score' },
  });

const coverageRule = (threshold = 80, extra: Record<string, unknown> = {}) =>
  makeRule({
    id: 'guard.block.official.test-coverage',
    domain: 'guard',
    action: 'block',
    content: { threshold, unit: 'percent', ...extra },
  });

const always = (value: GateValue) => () => value;

describe('post-scan gate — 阶段归属', () => {
  it('登记在 POST_SCAN_GATE_BINDINGS 的规则被识别为门禁，并带上指标口径', () => {
    const decl = readGateDeclaration(healthScoreRule(70));
    expect(decl.isGate).toBe(true);
    expect(decl.metric).toBe('health-score');
    expect(decl.threshold).toBe(70);
    expect(decl.declaredMetrics).toEqual(['value']);
  });

  it('GIVEN 规则显式声明 executionStage=post-scan WHEN 读取声明 THEN 也算门禁', () => {
    const rule = makeRule({
      id: 'inspect.scan.some-future-aggregate',
      content: { threshold: 90, unit: 'score', executionStage: 'post-scan' },
    });
    expect(readGateDeclaration(rule).isGate).toBe(true);
  });

  it('GIVEN 普通内联规则 WHEN 读取声明 THEN 不是门禁（不会被误摘出引擎）', () => {
    const rule = makeRule({
      id: 'guard.block.simple',
      content: { thresholds: { cyclomaticComplexity: 10 } },
    });
    expect(readGateDeclaration(rule).isGate).toBe(false);
    expect(selectPostScanGates([rule])).toHaveLength(0);
  });

  it('两条真门禁在登记表里 —— 登记表漏项会让规则退回「永远降级」', () => {
    expect(Object.keys(POST_SCAN_GATE_BINDINGS).sort()).toEqual([
      'guard.block.official.health-score',
      'guard.block.official.test-coverage',
    ]);
  });

  it('质量分映射规则归 mapping，不进判定清单（它没有通过线）', () => {
    const rule = makeRule({
      id: 'inspect.score.official.quality-score',
      domain: 'inspect',
      action: 'score',
      content: { threshold: 100, unit: 'score', mapping: { baseScore: 100, error: -10 } },
    });

    expect(MAPPING_RULES[rule.id]).toBeDefined();
    expect(readRuleSemantics(rule)).toBe('mapping');
    expect(readGateDeclaration(rule).isGate).toBe(false);
    expect(selectPostScanGates([rule])).toHaveLength(0);
  });

  it('映射型规则即使写了 executionStage=post-scan 也不进判定清单（不靠声明绕过）', () => {
    const rule = makeRule({
      id: 'inspect.score.official.quality-score',
      domain: 'inspect',
      action: 'score',
      content: { threshold: 100, executionStage: 'post-scan' },
    });

    expect(readGateDeclaration(rule).isGate).toBe(false);
    expect(readRuleSemantics(rule)).toBe('mapping');
  });
});

describe('post-scan gate — 判定三态', () => {
  it('GIVEN 实测值达标 WHEN 判定 THEN passed 且带实际值与阈值', () => {
    const report = evaluatePostScanGates([healthScoreRule(70)], always({ actual: 82 }));

    expect(report.total).toBe(1);
    expect(report.items[0].status).toBe('passed');
    expect(report.items[0].actual).toBe(82);
    expect(report.items[0].threshold).toBe(70);
    expect(report.items[0].message).toContain('健康分=82');
    expect(report.ok).toBe(true);
    expect(report.complete).toBe(true);
  });

  it('GIVEN 实测值低于下限阈值 WHEN 判定 THEN failed（覆盖率/分数是越高越好）', () => {
    const report = evaluatePostScanGates([coverageRule(80)], always({ actual: 63 }));

    expect(report.items[0].status).toBe('failed');
    expect(report.items[0].message).toContain('未达标');
    expect(report.failed).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('GIVEN 上限型阈值（无 unit）WHEN 实测超限 THEN failed —— 方向不能一律按下限算', () => {
    // 已登记口径的规则去掉 unit：没有 unit 时按上限型比较，875 > 300 应判越界。
    // 若方向表写错（一律按下限），875 ≥ 300 会被判「达标」。
    const rule = makeRule({
      id: 'guard.block.official.test-coverage',
      domain: 'guard',
      action: 'block',
      content: { threshold: 300 },
    });
    const report = evaluatePostScanGates([rule], always({ actual: 875 }));

    expect(report.items[0].status).toBe('failed');
  });

  it('GIVEN 数据源给不出数 WHEN 判定 THEN undetermined + 原因，且 ok 为 false', () => {
    const report = evaluatePostScanGates(
      [healthScoreRule(70)],
      always({ unavailableReason: '本轮未计算聚合评分' }),
    );

    expect(report.items[0].status).toBe('undetermined');
    expect(report.items[0].message).toContain('本轮未计算聚合评分');
    // 关键：未判定 ≠ 通过
    expect(report.ok).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.undetermined).toBe(1);
  });

  it('GIVEN 已声明为门禁但未登记指标口径 WHEN 判定 THEN undetermined 并指向登记表', () => {
    const rule = makeRule({
      id: 'inspect.scan.unregistered-gate',
      content: { threshold: 90, executionStage: 'post-scan' },
    });
    const report = evaluatePostScanGates([rule], always({ actual: 99 }));

    expect(report.items[0].status).toBe('undetermined');
    expect(report.items[0].message).toContain('POST_SCAN_GATE_BINDINGS');
  });

  it('GIVEN 没写可比较的 threshold WHEN 判定 THEN undetermined，不按 0 通过', () => {
    const report = evaluatePostScanGates([healthScoreRule()], always({ actual: 100 }));

    expect(report.items[0].status).toBe('undetermined');
    expect(report.items[0].message).toContain('未声明可比较的 threshold');
    expect(report.ok).toBe(false);
  });
});

describe('post-scan gate — 门禁有效性自证', () => {
  const rules: SopRule[] = [healthScoreRule(70), coverageRule(80)];
  const good: GateValue = { actual: 90 };

  it('全达标 ⇒ ok 为真（正向基线）', () => {
    expect(evaluatePostScanGates(rules, always(good)).ok).toBe(true);
  });

  it('喂一个坏值 ⇒ 必须变红（否则判据本身不会红，等于假门）', () => {
    const report = evaluatePostScanGates(rules, (rule) =>
      rule.id.includes('coverage') ? { actual: 10 } : good,
    );
    expect(report.ok).toBe(false);
    expect(report.items.find((i) => i.ruleId.includes('coverage'))!.status).toBe('failed');
  });

  it('喂「取不到数」⇒ 也必须不变绿（防「未检测=通过」复发）', () => {
    const report = evaluatePostScanGates(rules, () => ({ unavailableReason: '缺数据源' }));
    expect(report.ok).toBe(false);
    expect(report.undetermined).toBe(2);
  });

  it('逐条文本带状态标记，未判定不能显示成通过', () => {
    const lines = formatGateItems(
      evaluatePostScanGates(rules, (rule) =>
        rule.id.includes('coverage') ? { unavailableReason: '无报告' } : good,
      ),
    );
    expect(lines[0].startsWith('✓')).toBe(true);
    expect(lines[1].startsWith('–')).toBe(true);
  });
});

describe('post-scan gate — 阻断语义（action 决定，不看 severity）', () => {
  /**
   * 同一条覆盖率门禁，只把 action 从 block 改成 scan = 只报不拦。
   * 用已登记口径的 id 而不是新造 id：新 id 没有指标归属会落 undetermined，
   * 那样测的就不是「阻断语义」而是「缺口径」了。
   */
  const advisoryGate = () =>
    makeRule({
      id: 'guard.block.official.test-coverage',
      domain: 'guard',
      action: 'scan',
      content: { threshold: 80, unit: 'percent', severity: 'warning' },
    });

  it('GIVEN 非阻断门禁未达标 WHEN 判定 THEN 记 failed 但不拉红 ok（结论仍可见）', () => {
    const report = evaluatePostScanGates([advisoryGate()], always({ actual: 40 }));

    expect(report.items).toHaveLength(1);
    expect(report.items[0].blocking).toBe(false);
    expect(report.items[0].status).toBe('failed');
    expect(report.failed).toBe(1);
    expect(report.blockingFailed).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('GIVEN 阻断门禁未达标 WHEN 判定 THEN ok 为 false 且计数落在 blockingFailed', () => {
    const report = evaluatePostScanGates([coverageRule(80)], always({ actual: 40 }));

    expect(report.items[0].blocking).toBe(true);
    expect(report.blockingFailed).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('GIVEN 非阻断门禁取不到数 WHEN 判定 THEN 不阻断但 complete 仍为 false', () => {
    const report = evaluatePostScanGates([advisoryGate()], always({ unavailableReason: '缺数据源' }));

    expect(report.ok).toBe(true);
    expect(report.blockingUndetermined).toBe(0);
    expect(report.complete).toBe(false);
    expect(report.undetermined).toBe(1);
  });

  it('逐条文本给非阻断门禁加标注，避免面板把 advisory 读成阻断', () => {
    const lines = formatGateItems(evaluatePostScanGates([advisoryGate()], always({ actual: 40 })));
    expect(lines[0]).toContain('[不阻断]');
  });
});
