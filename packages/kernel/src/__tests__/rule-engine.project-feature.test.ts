import { describe, it, expect, beforeEach } from 'vitest';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

/**
 * M2 回归：规则引擎按项目画像裁剪规则集（ruleMatchesProject）。
 * 带 projectFeature 时仅评估匹配规则 + security 域；缺省时执行全量活跃规则。
 * 该筛选是"按画像精准服务项目"的判定核心，需锁定不回归。
 */
describe('SopRuleEngine — M2 画像裁剪（ruleMatchesProject）', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;

  beforeEach(() => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
  });

  it('带 projectFeature 时只评估匹配画像的规则', async () => {
    registry.register(
      makeRule({
        id: 'inspect.vue.component',
        domain: 'inspect',
        action: 'scan',
        tags: ['vue'],
        content: { patterns: ['NEVER_VUE'] },
      }),
    );
    registry.register(
      makeRule({
        id: 'inspect.nestjs.controller',
        domain: 'inspect',
        action: 'scan',
        tags: ['nestjs'],
        content: { patterns: ['NEVER_NEST'] },
      }),
    );

    // 画像：framework=nestjs + language=typescript。vue 标签命中不到，nestjs 命中
    const report = await engine.evaluateRules({
      repoRoot: '/tmp',
      domain: 'inspect',
      projectFeature: { framework: 'nestjs', language: 'typescript', features: [] },
    });

    const ids = report.evaluations.map((e) => e.rule.id);
    expect(ids).toContain('inspect.nestjs.controller');
    expect(ids).not.toContain('inspect.vue.component');
  });

  it('无 domain 过滤时 security 规则经画像恒命中（ruleMatchesProject 兜底）', async () => {
    registry.register(
      makeRule({
        id: 'security.vuln',
        domain: 'security',
        action: 'scan',
        content: { patterns: ['NEVER_SECURITY'] },
      }),
    );

    // 不带 domain：profile 过滤对 security 域恒放行
    const report = await engine.evaluateRules({
      repoRoot: '/tmp',
      projectFeature: { framework: 'react', features: [] },
    });
    expect(report.evaluations.map((e) => e.rule.id)).toEqual(['security.vuln']);
  });

  it('无 projectFeature 时执行全量活跃规则（不裁剪）', async () => {
    registry.register(
      makeRule({
        id: 'inspect.typescript.strict',
        domain: 'inspect',
        action: 'scan',
        tags: ['typescript'],
        content: { patterns: ['NEVER_TYPESCRIPT'] },
      }),
    );
    registry.register(
      makeRule({
        id: 'inspect.nestjs.controller',
        domain: 'inspect',
        action: 'scan',
        tags: ['nestjs'],
        content: { patterns: ['NEVER_NEST'] },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    expect(report.total).toBe(2);
  });

  it('runInspect（未显式 domain）按 JSDoc 评估 inspect + security 双域', async () => {
    registry.register(
      makeRule({
        id: 'inspect.code',
        domain: 'inspect',
        action: 'scan',
        content: { patterns: ['NEVER_INSPECT'] },
      }),
    );
    registry.register(
      makeRule({
        id: 'security.cve',
        domain: 'security',
        action: 'scan',
        content: { patterns: ['NEVER_SEC'] },
      }),
    );
    registry.register(
      makeRule({
        id: 'guard.block',
        domain: 'guard',
        action: 'scan',
        content: { patterns: ['NEVER_GUARD'] },
      }),
    );

    // 修复回归：runInspect 默认收起 inspect + security 两域（先前仅 inspect，security 被静默丢弃）
    const report = await engine.runInspect({ repoRoot: '/tmp' });
    const ids = report.evaluations.map((e) => e.rule.id);
    expect(ids).toContain('inspect.code');
    expect(ids).toContain('security.cve');
    expect(ids).not.toContain('guard.block'); // guard 域不进巡检
  });

  it('runInspect 显式单域 domain 时仍只评估该域（向后兼容）', async () => {
    registry.register(
      makeRule({
        id: 'security.cve',
        domain: 'security',
        action: 'scan',
        content: { patterns: ['NEVER_SEC'] },
      }),
    );
    registry.register(
      makeRule({
        id: 'inspect.code',
        domain: 'inspect',
        action: 'scan',
        content: { patterns: ['NEVER_INSPECT'] },
      }),
    );

    const report = await engine.runInspect({ repoRoot: '/tmp', domain: 'inspect' });
    const ids = report.evaluations.map((e) => e.rule.id);
    expect(ids).toEqual(['inspect.code']);
  });

  it('通用规则（无栈标签）不被画像裁剪：修复 monorepo 画像欠采样的过度裁剪', async () => {
    registry.register(
      makeRule({
        id: 'inspect.duplication',
        domain: 'inspect',
        action: 'scan',
        tags: ['duplication', 'quality', 'dry'],
        content: { patterns: ['NEVER_DUPLICATE'] },
      }),
    );
    registry.register(
      makeRule({
        id: 'inspect.nestjs.controller',
        domain: 'inspect',
        action: 'scan',
        tags: ['nestjs'],
        content: { patterns: ['NEVER_NEST'] },
      }),
    );

    // 画像只有 language=typescript（无 framework）—— 模拟 monorepo 仅识别到根包语言、漏判子包框架
    const report = await engine.evaluateRules({
      repoRoot: '/tmp',
      domain: 'inspect',
      projectFeature: { language: 'typescript', features: [] },
    });

    const ids = report.evaluations.map((e) => e.rule.id);
    // 通用 duplication 规则不带栈标签 → 恒保留；nestjs 规则不匹配 typescript 栈 → 裁剪
    expect(ids).toContain('inspect.duplication');
    expect(ids).not.toContain('inspect.nestjs.controller');
  });
});
