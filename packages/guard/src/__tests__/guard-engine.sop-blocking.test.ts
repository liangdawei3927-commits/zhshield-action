import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { GuardEngine } from '../engine';
import { SopRuleEngine, SopRegistry } from '@zh/kernel';
import type { SopRule, Issue, ToolAdapter, ToolResult, ToolScanOptions } from '@zh/shared';

const RULE_ID = 'guard.block.guard-blocking-demo';

function makeSopRule(overrides: Partial<SopRule> & { id: string }): SopRule {
  return {
    id: overrides.id,
    name: overrides.name ?? 'guard-blocking-test-rule',
    domain: overrides.domain ?? 'guard',
    action: overrides.action ?? 'block',
    source: overrides.source ?? 'official',
    description: overrides.description ?? '',
    status: overrides.status ?? 'active',
    executionMode: overrides.executionMode ?? 'sync',
    severity: overrides.severity ?? 'medium',
    ...(overrides.accumulationPolicy !== undefined
      ? { accumulationPolicy: overrides.accumulationPolicy }
      : {}),
    ...(overrides.blockingThreshold !== undefined
      ? { blockingThreshold: overrides.blockingThreshold }
      : {}),
    applicableEngines: overrides.applicableEngines ?? ['guard'],
    content: overrides.content ?? {},
    tags: overrides.tags ?? [],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

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

function failingEslintAdapter(): ToolAdapter {
  return {
    meta: {
      id: 'eslint',
      name: 'ESLint',
      category: 'guard',
      priority: 'P1',
      installMode: 'builtin',
      description: '',
      cliCommand: '',
      homepage: '',
      license: '',
    },
    isAvailable: async () => true,
    scan: async (_opts: ToolScanOptions): Promise<ToolResult> => ({
      tool: 'eslint',
      status: 'available',
      issues: [demoIssue()],
      metadata: { version: '', duration: 1, timestamp: new Date(), fileCount: 0 },
    }),
  };
}

function buildGuardWithRule(rule: SopRule): GuardEngine {
  const registry = new SopRegistry();
  const sopEngine = new SopRuleEngine(registry, {
    toolAdapters: [{ name: 'eslint', adapter: failingEslintAdapter() }],
  });
  registry.register(rule);
  const repoRoot = os.tmpdir();
  const guard = new GuardEngine(repoRoot);
  guard.useSopEngine(sopEngine);
  return guard;
}

describe('GuardEngine — F1-4 SOP 阻断判定消费', () => {
  it('存量路径：未声明阈值的规则失败 → CheckResult.blocking=true、summary.blocking=1、ok=false（旧行为不变）', async () => {
    const guard = buildGuardWithRule(
      makeSopRule({
        id: RULE_ID,
        severity: 'medium',
        content: { check: { tool: 'eslint', toolConfig: {} } },
      }),
    );

    const report = await guard.run({ mode: 'guard' });
    expect(report.results[0]?.status).toBe('failed');
    expect(report.results[0]?.blocking).toBe(true);
    expect(report.summary.blocking).toBe(1);
    expect(report.summary.failed).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('有效严重级低于阈值（medium < critical）→ 不阻断，但 ok 仍为 false（状态驱动不变量）', async () => {
    const guard = buildGuardWithRule(
      makeSopRule({
        id: RULE_ID,
        severity: 'medium',
        blockingThreshold: 'critical',
        content: { check: { tool: 'eslint', toolConfig: {} } },
      }),
    );

    const report = await guard.run({ mode: 'guard' });
    expect(report.results[0]?.status).toBe('failed');
    expect(report.results[0]?.severity).toBe('warning');
    expect(report.results[0]?.blocking).toBe(false);
    expect(report.summary.blocking).toBe(0);
    expect(report.summary.failed).toBe(1);
    expect(report.ok).toBe(false);
  });

  it("连续失败升级到 'critical' 达到阈值 → 第二次运行阻断，ok 语义与第一次完全一致（均为 false）", async () => {
    const guard = buildGuardWithRule(
      makeSopRule({
        id: RULE_ID,
        severity: 'medium',
        accumulationPolicy: { threshold: 1, escalateTo: 'critical' },
        blockingThreshold: 'critical',
        content: { check: { tool: 'eslint', toolConfig: {} } },
      }),
    );

    // 第 1 次：有效严重级 medium < critical → 不阻断；ok=false
    const r1 = await guard.run({ mode: 'guard' });
    expect(r1.results[0]?.blocking).toBe(false);
    expect(r1.summary.blocking).toBe(0);
    expect(r1.ok).toBe(false);

    // 第 2 次：升级 critical >= critical → 阻断；ok 仍由状态驱动为 false
    const r2 = await guard.run({ mode: 'guard' });
    expect(r2.results[0]?.status).toBe('failed');
    expect(r2.results[0]?.blocking).toBe(true);
    expect(r2.summary.blocking).toBe(1);
    expect(r2.ok).toBe(false);
  });
});
