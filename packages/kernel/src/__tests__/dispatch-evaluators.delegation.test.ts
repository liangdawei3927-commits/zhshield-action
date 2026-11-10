import { describe, it, expect, beforeEach } from 'vitest';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

/**
 * R7 归属让位：非本域 Owner 的规则在缺适配器时**不得**落 degraded。
 *
 * 背景（2026-11-11 实机）：`inspect.scan.external.dependency-audit` 在体检域每轮
 * 必 degraded（npm-audit / trivy / grype 均未注册适配器），而 O10 已把依赖审计
 * 唯一归 deps。degraded 的语义是「本该由本域跑却没跑成」，一条归 deps 的规则
 * 在体检域缺适配器属于**让位**，标 degraded 会让每轮扫描固定产出一条假降级、
 * 并永久拉低体检覆盖率（R6 口径）。
 */
describe('SopRuleEngine — R7 归属让位（缺适配器时不降级）', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;

  beforeEach(() => {
    registry = new SopRegistry();
    // 不注册任何工具适配器：命中「未注册工具适配器」分支
    engine = new SopRuleEngine(registry, {});
  });

  it('归 deps 的依赖审计规则在体检域 → skipped 且 degraded 不置位', async () => {
    registry.register(
      makeRule({
        id: 'inspect.scan.external.dependency-audit',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { check: { tool: 'npm-audit', toolConfig: {} } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    const evaluation = report.evaluations[0];

    expect(evaluation.status).toBe('skipped');
    expect(evaluation.degraded).toBeUndefined();
    expect(evaluation.message).toContain('deps');
    expect(evaluation.message).toContain('本域不重复评估');
    // 让位不计入降级数
    expect(report.degraded ?? 0).toBe(0);
  });

  it('本域自有规则缺适配器 → 仍落 skipped + degraded（不许静默通过）', async () => {
    registry.register(
      makeRule({
        id: 'inspect.scan.internal.own-tool-rule',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { check: { tool: 'not-registered-tool', toolConfig: {} } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    const evaluation = report.evaluations[0];

    expect(evaluation.status).toBe('skipped');
    expect(evaluation.degraded).toBe(true);
    expect(report.degraded).toBe(1);
  });
});
