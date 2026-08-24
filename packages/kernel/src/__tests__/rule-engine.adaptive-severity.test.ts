import { describe, it, expect, beforeEach } from 'vitest';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';
import type { Issue, ToolAdapter, ToolResult, ToolScanOptions } from '@zh/shared';

const RULE_ID = 'guard.block.adaptive-demo';

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

describe('SopRuleEngine — F1-3 动态严重级集成（连续失败计数 × 升级）', () => {
  let registry: SopRegistry;

  beforeEach(() => {
    registry = new SopRegistry();
  });

  it('threshold=2：升级判定用本次自增前的计数 → 第 3 次评估生效；一次通过归零后从静态重新累积', async () => {
    let shouldFail = true;
    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: controlledAdapter(() => shouldFail) }],
    });
    registry.register(makeRule({
      id: RULE_ID,
      domain: 'guard',
      action: 'block',
      severity: 'medium',
      accumulationPolicy: { threshold: 2, escalateTo: 'high' },
      content: { check: { tool: 'eslint', toolConfig: {} } },
    }));

    // 第 1 次：判定用计数 0 → 静态 medium；失败后计数 → 1
    const r1 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r1.evaluations[0]?.status).toBe('failed');
    expect(r1.evaluations[0]?.rule.severity).toBe('medium');

    // 第 2 次：判定用计数 1（<2）→ 仍 medium；失败后计数 → 2
    const r2 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r2.evaluations[0]?.rule.severity).toBe('medium');

    // 第 3 次：判定用计数 2（>=2）→ high
    const r3 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r3.evaluations[0]?.rule.severity).toBe('high');

    // registry 存储对象从未被修改
    expect(registry.get(RULE_ID)?.severity).toBe('medium');

    // PASS：判定先于结果、用归零前的旧计数（显示 high），但计数归零
    shouldFail = false;
    const r4 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r4.evaluations[0]?.status).toBe('passed');
    expect(r4.evaluations[0]?.rule.severity).toBe('high');

    // 归零后的下一次失败从静态 severity 重新开始
    shouldFail = true;
    const r5 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r5.evaluations[0]?.rule.severity).toBe('medium');
    expect(registry.get(RULE_ID)?.severity).toBe('medium');
  });

  it('check-list 路径：RuleEvaluation.rule.severity 与 Violation.severity 均反映升级后的值', async () => {
    const mockGuard = {
      run: async (_opts: { mode: string; checks: string[] }) => ({
        summary: { total: 1, passed: 0, failed: 1 },
        results: [{ status: 'failed', message: 'no-unused-vars found' }],
      }),
    };
    const engine = new SopRuleEngine(registry, { guardEngine: mockGuard });
    registry.register(makeRule({
      id: 'guard.block.adaptive-checklist',
      domain: 'guard',
      action: 'block',
      severity: 'medium',
      accumulationPolicy: { threshold: 1, escalateTo: 'high' },
      content: { checks: [{ rule: 'no-unused-vars', level: 'error' }] },
    }));

    const r1 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r1.evaluations[0]?.rule.severity).toBe('medium');
    expect(r1.evaluations[0]?.violations?.[0]?.severity).toBe('medium');

    const r2 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r2.evaluations[0]?.rule.severity).toBe('high');
    expect(r2.evaluations[0]?.violations?.[0]?.severity).toBe('high');
    expect(registry.get('guard.block.adaptive-checklist')?.severity).toBe('medium');
  });

  it('skipped 评估不动计数器：dryRun 跳过不计入连续失败', async () => {
    const shouldFail = true;
    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: controlledAdapter(() => shouldFail) }],
    });
    registry.register(makeRule({
      id: RULE_ID,
      domain: 'guard',
      action: 'block',
      severity: 'medium',
      accumulationPolicy: { threshold: 1, escalateTo: 'high' },
      content: { check: { tool: 'eslint', toolConfig: {} } },
    }));

    // skipped：计数保持 0
    const skipped = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard', dryRun: true });
    expect(skipped.evaluations[0]?.status).toBe('skipped');

    // 若 skipped 曾被计入，此处判定计数已 >=1 会直接升级；实际应仍为静态 medium
    const r1 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r1.evaluations[0]?.rule.severity).toBe('medium');

    // 第二次真实失败：判定用计数 1（>=1）→ high
    const r2 = await engine.evaluateRules({ repoRoot: '/proj', domain: 'guard' });
    expect(r2.evaluations[0]?.rule.severity).toBe('high');
  });

  it('healthBaseline < 60：无策略规则的有效严重级上移一档，registry 不变', async () => {
    const engine = new SopRuleEngine(registry, {
      healthBaseline: 30,
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
    expect(report.evaluations[0]?.rule.severity).toBe('error');
    expect(registry.get(RULE_ID)?.severity).toBe('medium');
  });
});
