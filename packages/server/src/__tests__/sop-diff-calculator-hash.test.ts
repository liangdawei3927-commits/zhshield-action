import { describe, it, expect } from 'vitest';
import { SopDiffCalculator } from '../sop/sop-diff-calculator';
import type { RuleHashes } from '../sop/sop-diff-calculator';
import { SopRegistry } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';

function makeRule(overrides: Partial<SopRule> & { id: string }): SopRule {
  return {
    name: overrides.name ?? overrides.id,
    domain: overrides.domain ?? 'guard',
    action: overrides.action ?? 'scan',
    source: overrides.source ?? 'official',
    description: overrides.description ?? '',
    status: overrides.status ?? 'active',
    executionMode: overrides.executionMode ?? 'sync',
    severity: overrides.severity ?? 'medium',
    applicableEngines: overrides.applicableEngines ?? ['guard'],
    content: overrides.content ?? {},
    serves: overrides.serves,
    tags: overrides.tags ?? [],
    falsePositiveCount: overrides.falsePositiveCount ?? 0,
    truePositiveCount: overrides.truePositiveCount ?? 0,
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX8 = /^[0-9a-f]{8}$/;

describe('SopDiffCalculator.computeRuleHash 三哈希方案（二.2）', () => {
  it('稳定性：同一规则重复计算，三重哈希完全一致', () => {
    const calc = new SopDiffCalculator();
    const rule = makeRule({ id: 'a.rule', content: { level: 'error' } });

    expect(calc.computeRuleHash(rule)).toEqual(calc.computeRuleHash(rule));
  });

  it('content 哈希与键序无关：content 字段键序不同 → content/quick 一致', () => {
    const calc = new SopDiffCalculator();
    const a = makeRule({ id: 'a.rule', content: { level: 'error', scope: 'src' } });
    const b = makeRule({ id: 'a.rule', content: { scope: 'src', level: 'error' } });

    const ha = calc.computeRuleHash(a);
    const hb = calc.computeRuleHash(b);
    expect(ha.content).toBe(hb.content);
    expect(ha.quick).toBe(hb.quick);
  });

  it('内容敏感：语义内容变更 → 三重哈希全部改变', () => {
    const calc = new SopDiffCalculator();
    const before = calc.computeRuleHash(makeRule({ id: 'a.rule', severity: 'high' }));
    const after = calc.computeRuleHash(makeRule({ id: 'a.rule', severity: 'critical' }));

    expect(after.content).not.toBe(before.content);
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.quick).not.toBe(before.quick);
  });

  it('精确度：仅误报计数变化 → content 不变而 sha256 改变（易变元数据不触发 modified）', () => {
    const calc = new SopDiffCalculator();
    const before = calc.computeRuleHash(makeRule({ id: 'a.rule' }));
    const after = calc.computeRuleHash(
      makeRule({ id: 'a.rule', falsePositiveCount: 7, truePositiveCount: 3 }),
    );

    expect(after.content).toBe(before.content);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it('sha256 抗碰属性：不同规则 → 不同摘要，且为 64 位十六进制（SHA-256 位长）', () => {
    const calc = new SopDiffCalculator();
    const hashes = Array.from({ length: 50 }, (_, i) =>
      calc.computeRuleHash(makeRule({ id: `rule-${i}`, content: { index: i } })),
    );

    for (const h of hashes) {
      expect(h.sha256).toMatch(HEX64);
      expect(h.content).toMatch(HEX64);
    }
    expect(new Set(hashes.map((h) => h.sha256)).size).toBe(50);
    expect(new Set(hashes.map((h) => h.content)).size).toBe(50);
  });

  it('quick 指纹确定性：同输入恒定输出 8 位十六进制，且与 sha256 可区分', () => {
    const calc = new SopDiffCalculator();
    const rule = makeRule({ id: 'a.rule' });

    const first = calc.computeRuleHash(rule);
    const second = calc.computeRuleHash(rule);
    expect(first.quick).toBe(second.quick);
    expect(first.quick).toMatch(HEX8);
    expect(first.quick).not.toBe(first.sha256);
  });
});

describe('SopDiffCalculator.storeVersionHashes / getStoredHash', () => {
  it('留存后可按版本与规则 ID 取回各变体哈希，未留存返回 undefined', () => {
    const calc = new SopDiffCalculator();
    const rule = makeRule({ id: 'a.rule' });
    const hashes = new Map<string, RuleHashes>([['a.rule', calc.computeRuleHash(rule)]]);

    calc.storeVersionHashes('1.2026.08.20.001', hashes);

    const stored = calc.computeRuleHash(rule);
    expect(calc.getStoredHash('1.2026.08.20.001', 'a.rule')).toBe(stored.content);
    expect(calc.getStoredHash('1.2026.08.20.001', 'a.rule', 'sha256')).toBe(stored.sha256);
    expect(calc.getStoredHash('1.2026.08.20.001', 'a.rule', 'quick')).toBe(stored.quick);
    expect(calc.getStoredHash('1.2026.08.20.001', 'missing.rule')).toBeUndefined();
    expect(calc.getStoredHash('0.0.0', 'a.rule')).toBeUndefined();
  });

  it('快照容量上限：超过 10 个版本时淘汰最早留存的版本', () => {
    const calc = new SopDiffCalculator();
    const rule = makeRule({ id: 'a.rule' });
    const hashes = new Map<string, RuleHashes>([['a.rule', calc.computeRuleHash(rule)]]);

    for (let i = 0; i < 12; i++) {
      calc.storeVersionHashes(`1.2026.08.${String(i + 1).padStart(2, '0')}.001`, hashes);
    }

    expect(calc.getStoredHash('1.2026.08.01.001', 'a.rule')).toBeUndefined();
    expect(calc.getStoredHash('1.2026.08.12.001', 'a.rule')).toBeDefined();
  });

  it('computeDiff 自动留存目标版本快照：下次以该版本为起点时按内容精确分类', () => {
    const calc = new SopDiffCalculator();
    const registry = new SopRegistry();
    registry.loadAll([makeRule({ id: 'keep.rule' }), makeRule({ id: 'edit.rule' })]);

    const first = calc.computeDiff(registry, '2025.12.31', '2026.01.01');
    expect(first.modified.map((r) => r.id)).toContain('edit.rule');

    // 仅更新误报计数（updatedAt 变化但语义内容不变）：启发式会误判 modified，
    // 内容哈希比对应判 unchanged
    registry.update('edit.rule', { falsePositiveCount: 5, updatedAt: new Date('2026-06-01') });
    registry.update('keep.rule', { truePositiveCount: 2, updatedAt: new Date('2026-06-01') });

    const second = calc.computeDiff(registry, '2026.01.01', '2026.06.02');
    expect(second.unchanged.sort()).toEqual(['edit.rule', 'keep.rule']);
    expect(second.modified).toEqual([]);
  });
});
