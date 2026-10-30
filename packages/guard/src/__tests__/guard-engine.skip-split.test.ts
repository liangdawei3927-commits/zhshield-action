import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { GuardEngine } from '../engine';
import { SopRuleEngine, SopRegistry } from '@zh/kernel';
import type { SopRule } from '@zh/shared';

/**
 * 跳过必须二分（2026-10-30 缺陷回归锁）。
 *
 * 背景：`guard.block.official.health-score` / `guard.block.official.test-coverage`
 * 是**后置门禁**规则 —— 它们的阈值要比的是「整轮扫描结束后的聚合分/覆盖率」，
 * 引擎在扫描过程中必然拿不到，因此内核侧显式让位（`status: 'skipped'`，
 * 不带 `degraded`）。但 guard 引擎曾把 `skipped` 一律折叠成 `warning`，
 * 于是这两条以「中危 · 需处理」出现在门禁页，并被一键复制进「AI 修复」提示词，
 * 让编码工具去「修」一条正文写着「引擎内不求值」的规则。
 *
 * 本用例锁两件事，缺一不可：
 *  · 让位 → `skipped`，不进 warnings、不产 finding；
 *  · 降级（工具不可用）→ 仍是 `warning` + `degraded`，不得被让位的豁免吞掉。
 */

const HEALTH_SCORE_RULE_ID = 'guard.block.official.health-score';
const MISSING_TOOL_RULE_ID = 'guard.block.missing-tool-demo';

function makeSopRule(overrides: Partial<SopRule> & { id: string }): SopRule {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    domain: overrides.domain ?? 'guard',
    action: overrides.action ?? 'block',
    source: overrides.source ?? 'official',
    description: overrides.description ?? '',
    status: overrides.status ?? 'active',
    executionMode: overrides.executionMode ?? 'sync',
    severity: overrides.severity ?? 'error',
    applicableEngines: overrides.applicableEngines ?? ['guard'],
    content: overrides.content ?? {},
    tags: overrides.tags ?? [],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildGuard(rules: SopRule[]): GuardEngine {
  const registry = new SopRegistry();
  const sopEngine = new SopRuleEngine(registry, { toolAdapters: [] });
  for (const rule of rules) registry.register(rule);
  const guard = new GuardEngine(os.tmpdir());
  guard.useSopEngine(sopEngine);
  return guard;
}

describe('GuardEngine — 跳过的二分（让位 vs 降级）', () => {
  it('后置门禁让位 → status=skipped、不计 warning、不阻塞', async () => {
    const guard = buildGuard([
      makeSopRule({
        id: HEALTH_SCORE_RULE_ID,
        severity: 'error',
        content: { check: { type: 'threshold', threshold: 70, unit: '分' } },
      }),
    ]);

    const report = await guard.run({ mode: 'guard' });
    const check = report.results.find((r) => r.checkId === HEALTH_SCORE_RULE_ID);

    expect(check?.status).toBe('skipped');
    expect(check?.degraded).toBeUndefined();
    // 关键断言：折叠成 warning 会让它同时出现在「警告」计数与「需处理」清单里
    expect(report.summary.warnings).toBe(0);
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.blocking).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('工具不可用的降级跳过 → status=warning、degraded=true，仍计入警告（未检测 ≠ 通过）', async () => {
    const guard = buildGuard([
      makeSopRule({
        id: MISSING_TOOL_RULE_ID,
        severity: 'error',
        content: { check: { tool: 'tool-that-does-not-exist' } },
      }),
    ]);

    const report = await guard.run({ mode: 'guard' });
    const check = report.results.find((r) => r.checkId === MISSING_TOOL_RULE_ID);

    expect(check?.status).toBe('warning');
    expect(check?.degraded).toBe(true);
    expect(report.summary.warnings).toBe(1);
    expect(report.summary.skipped).toBe(0);
  });

  it('让位与降级同时存在时分别计数，二者互不吞并', async () => {
    const guard = buildGuard([
      makeSopRule({
        id: HEALTH_SCORE_RULE_ID,
        severity: 'error',
        content: { check: { type: 'threshold', threshold: 70, unit: '分' } },
      }),
      makeSopRule({
        id: MISSING_TOOL_RULE_ID,
        severity: 'error',
        content: { check: { tool: 'tool-that-does-not-exist' } },
      }),
    ]);

    const report = await guard.run({ mode: 'guard' });
    expect(report.summary.total).toBe(2);
    expect(report.summary.warnings).toBe(1);
    expect(report.summary.skipped).toBe(1);
    // 总数可对本：passed + failed + warnings + errors + skipped === total
    const s = report.summary;
    expect(s.passed + s.failed + s.warnings + s.errors + (s.skipped ?? 0)).toBe(s.total);
  });
});
