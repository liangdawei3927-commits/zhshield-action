import { describe, expect, it } from 'vitest';

import type { SopRule } from '../sop/_meta/sop-types';
import {
  buildCurrentVersions,
  computeRuleContentSha,
  needsHeal,
  verifyRuleManifest,
} from '../sop/cache/sop-resolve-verifier';

let seq = 0;

function makeRule(overrides: Partial<SopRule> = {}): SopRule {
  seq += 1;
  return {
    id: `inspect.scan.external.rule-${seq}`,
    name: `规则 ${seq}`,
    domain: 'inspect',
    action: 'scan',
    source: 'external',
    description: '测试规则',
    status: 'active',
    executionMode: 'sync',
    severity: 'medium',
    applicableEngines: ['inspect'],
    content: { tool: 'eslint' },
    tags: ['test'],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('computeRuleContentSha', () => {
  it('同内容规则哈希稳定（确定性）', () => {
    const base = makeRule();
    const copy: SopRule = { ...base, falsePositiveCount: 7, updatedAt: new Date() };
    expect(computeRuleContentSha(copy)).toBe(computeRuleContentSha(base));
  });

  it('内容变化 → 哈希变化', () => {
    const base = makeRule();
    const changed = makeRule();
    changed.id = base.id;
    changed.severity = 'high';
    expect(computeRuleContentSha(changed)).not.toBe(computeRuleContentSha(base));
  });

  it('键序不同但内容相同 → 哈希一致（确定性序列化）', () => {
    const base = makeRule({ content: { tool: 'eslint', preset: 'recommended' } });
    const reordered: SopRule = { ...base, content: { preset: 'recommended', tool: 'eslint' } };
    expect(computeRuleContentSha(reordered)).toBe(computeRuleContentSha(base));
  });
});

describe('buildCurrentVersions', () => {
  it('规则 → ruleId 到 contentSha 的映射', () => {
    const rules = [makeRule(), makeRule()];
    const versions = buildCurrentVersions(rules);
    expect(Object.keys(versions)).toHaveLength(2);
    for (const rule of rules) {
      expect(versions[rule.id]).toBe(computeRuleContentSha(rule));
    }
  });
});

describe('verifyRuleManifest', () => {
  it('清单与本地一致 → 无漂移', () => {
    const rules = [makeRule(), makeRule()];
    const manifest = rules.map((r) => ({
      ruleId: r.id,
      version: '1.0.0',
      sha: computeRuleContentSha(r),
      source: 'manual',
    }));
    const report = verifyRuleManifest(rules, manifest);
    expect(report).toMatchObject({
      expected: 2,
      active: 2,
      missing: [],
      shaMismatch: [],
      unexpected: [],
    });
    expect(needsHeal(report)).toBe(false);
  });

  it('云端有本地无 → missing（触发自愈）', () => {
    const rules = [makeRule()];
    const ghost = makeRule();
    const manifest = [
      {
        ruleId: rules[0].id,
        version: '1.0.0',
        sha: computeRuleContentSha(rules[0]),
        source: 'manual',
      },
      { ruleId: ghost.id, version: '1.0.0', sha: null, source: 'manual' },
    ];
    const report = verifyRuleManifest(rules, manifest);
    expect(report.missing).toEqual([ghost.id]);
    expect(needsHeal(report)).toBe(true);
  });

  it('内容哈希不一致 → shaMismatch（触发自愈）', () => {
    const rule = makeRule();
    const manifest = [{ ruleId: rule.id, version: '1.0.0', sha: 'deadbeef', source: 'manual' }];
    const report = verifyRuleManifest([rule], manifest);
    expect(report.shaMismatch).toEqual([rule.id]);
    expect(needsHeal(report)).toBe(true);
  });

  it('云端 sha 为 null → 跳过内容比对', () => {
    const rule = makeRule();
    const manifest = [{ ruleId: rule.id, version: '1.0.0', sha: null, source: 'manual' }];
    const report = verifyRuleManifest([rule], manifest);
    expect(report.shaMismatch).toEqual([]);
    expect(needsHeal(report)).toBe(false);
  });

  it('本地多出云端清单外的规则 → unexpected 仅观测不触发自愈', () => {
    const localOnly = makeRule();
    const manifest = [
      {
        ruleId: localOnly.id,
        version: '1.0.0',
        sha: computeRuleContentSha(localOnly),
        source: 'manual',
      },
    ];
    const report = verifyRuleManifest([localOnly], manifest);
    expect(report.missing).toEqual([]);
    expect(report.shaMismatch).toEqual([]);
    expect(needsHeal(report)).toBe(false);

    const extra = makeRule();
    const report2 = verifyRuleManifest([localOnly, extra], manifest);
    expect(report2.unexpected).toEqual([extra.id]);
    expect(needsHeal(report2)).toBe(false);
  });
});
