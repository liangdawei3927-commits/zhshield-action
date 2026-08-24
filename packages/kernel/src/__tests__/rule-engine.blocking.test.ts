import { describe, it, expect, beforeEach } from 'vitest';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';
import type { Issue, ToolAdapter, ToolResult, ToolScanOptions } from '@zh/shared';

const RULE_ID = 'guard.block.blocking-demo';

function demoIssue(): Issue {
  return {
    id: 'iss-1',
    ruleId: RULE_ID,
    severity: 'warning',
    category: 'quality',
    message: 'demo violation',
    file: 'src/a.ts',
    autoFixable: false,
    source: 'guard',
    fingerprint: 'fp-1',
  };
}

function controlledAdapter(shouldFail: () => boolean): ToolAdapter {
  return {
    meta: { id: 'eslint', name: 'ESLint', category: 'guard', priority: 'P1', installMode: 'builtin', description: '', cliCommand: '', homepage: '', license: '' },
    isAvailable: async () => true,
    scan: async (_opts: ToolScanOptions): Promise<ToolResult> => ({
      tool: 'eslint',
      status: 'available',
      issues: shouldFail() ? [demoIssue()] : [],
      metadata: { version: '', duration: 1, timestamp: new Date(), fileCount: 0 },
    }),
  };
}

describe('SopRuleEngine — F1-4 阻断判定集成', () => {
  let registry: SopRegistry;

  beforeEach(() => {
    registry = new SopRegistry();
  });

  it('未声明 blockingThreshold 的规则失败 → blocking=true、ok=false、blockingCount=1（旧行为保留）', async () => {
    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: controlledAdapter(() => true) }],
    });
    registry.register(makeRule({
      id: RULE_ID,
      domain: 'guard',
      action: 'block',
      severity: 'medium',
      content: { check: { tool: 'eslint', toolConfig: {} } },
    }));

    const report = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(report.evaluations[0]?.status).toBe('failed');
    expect(report.evaluations[0]?.blocking).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.blockingCount).toBe(1);
  });

  it("声明 blockingThreshold:'critical' 而有效严重级为静态 'medium' 失败 → blocking=false，但 ok 仍为 false（不变量）", async () => {
    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: controlledAdapter(() => true) }],
    });
    registry.register(makeRule({
      id: RULE_ID,
      domain: 'guard',
      action: 'block',
      severity: 'medium',
      blockingThreshold: 'critical',
      content: { check: { tool: 'eslint', toolConfig: {} } },
    }));

    const report = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(report.evaluations[0]?.status).toBe('failed');
    expect(report.evaluations[0]?.rule.severity).toBe('medium');
    expect(report.evaluations[0]?.blocking).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.blockingCount).toBe(0);
  });

  it("accumulationPolicy {threshold:1} 升级到 'critical' 后第二次运行 → blocking=true、blockingCount=1", async () => {
    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: controlledAdapter(() => true) }],
    });
    registry.register(makeRule({
      id: RULE_ID,
      domain: 'guard',
      action: 'block',
      severity: 'medium',
      accumulationPolicy: { threshold: 1, escalateTo: 'critical' },
      blockingThreshold: 'critical',
      content: { check: { tool: 'eslint', toolConfig: {} } },
    }));

    // 第 1 次：判定计数 0（<1）→ 有效严重级仍 medium < critical → 不阻断
    const r1 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r1.evaluations[0]?.status).toBe('failed');
    expect(r1.evaluations[0]?.rule.severity).toBe('medium');
    expect(r1.evaluations[0]?.blocking).toBe(false);
    expect(r1.ok).toBe(false);
    expect(r1.blockingCount).toBe(0);

    // 第 2 次：判定计数 1（>=1）→ 升级 critical >= threshold critical → 阻断
    const r2 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r2.evaluations[0]?.status).toBe('failed');
    expect(r2.evaluations[0]?.rule.severity).toBe('critical');
    expect(r2.evaluations[0]?.blocking).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.blockingCount).toBe(1);

    // registry 存储对象未被修改
    expect(registry.get(RULE_ID)?.severity).toBe('medium');
  });

  it('error 评估不阻断：适配器抛异常 → blocking=false 且 blockingCount=0，ok 仍由状态驱动为 false', async () => {
    const crashingAdapter: ToolAdapter = {
      meta: { id: 'eslint', name: 'ESLint', category: 'guard', priority: 'P1', installMode: 'builtin', description: '', cliCommand: '', homepage: '', license: '' },
      isAvailable: async () => true,
      scan: async (): Promise<ToolResult> => {
        throw new Error('adapter crashed');
      },
    };
    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: crashingAdapter }],
    });
    registry.register(makeRule({
      id: RULE_ID,
      domain: 'guard',
      action: 'block',
      severity: 'critical',
      content: { check: { tool: 'eslint', toolConfig: {} } },
    }));

    const report = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(report.evaluations[0]?.status).toBe('error');
    expect(report.evaluations[0]?.blocking).toBe(false);
    expect(report.blockingCount).toBe(0);
    expect(report.ok).toBe(false);
  });
});
