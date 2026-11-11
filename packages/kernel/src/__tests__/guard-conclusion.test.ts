import { describe, it, expect } from 'vitest';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';
import type { ToolAdapter } from '@zh/shared';

/**
 * 门禁纯判定（《07》O8 / C3 / A6）
 *
 * 判据 A6：门禁工具调用数 = 0。注入 `conclusions` 后，guard 域的 tool-dispatch
 * 不得调用任何 ToolAdapter.scan（这里用计数适配器直接断言），只读供应商域结论。
 *
 * 同时锁 C4：供应商域无结论 → skipped 且不标 degraded（不进 issues、不判通过）；
 * 工具故障条目（toolError）不得被当成代码问题让门禁失败。
 */
describe('门禁纯判定 — 工具调用归零、只读各域结论', () => {
  const buildEngine = (scanCounter: { calls: number }) => {
    const registry = new SopRegistry();
    const eslintAdapter = {
      meta: {
        id: 'eslint',
        name: 'ESLint',
        category: 'inspect' as const,
        priority: 'P1' as const,
        installMode: 'external' as const,
        description: '',
        cliCommand: '',
        homepage: '',
        license: '',
      },
      isAvailable: async () => true,
      scan: async () => {
        scanCounter.calls += 1;
        return {
          tool: 'eslint',
          status: 'available' as const,
          issues: [],
          metadata: { duration: 0 },
        };
      },
    } as unknown as ToolAdapter;
    return {
      registry,
      engine: new SopRuleEngine(registry, {
        toolAdapters: [{ name: 'eslint', adapter: eslintAdapter }],
      }),
    };
  };

  const registerEslintRule = (registry: SopRegistry) => {
    registry.register(
      makeRule({
        id: 'guard.block.official.eslint-error',
        domain: 'guard',
        severity: 'error',
        content: { check: { tool: 'eslint', severity: 'error' } },
      }),
    );
  };

  it('注入结论集 → guard 不调用工具（A6），缺结论时 skipped 且不判通过（C4）', async () => {
    const counter = { calls: 0 };
    const { registry, engine } = buildEngine(counter);
    registerEslintRule(registry);

    const report = await engine.evaluateRules({ repoRoot: '/tmp', conclusions: {} });

    expect(counter.calls).toBe(0);
    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].degraded).toBeUndefined();
    expect(report.evaluations[0].message).toContain('inspect 域');
  });

  it('未注入结论集 → 保持历史工具派发（存量调用方兼容边界）', async () => {
    const counter = { calls: 0 };
    const { registry, engine } = buildEngine(counter);
    registerEslintRule(registry);

    await engine.evaluateRules({ repoRoot: '/tmp' });

    expect(counter.calls).toBe(1);
  });

  it('通过项回显快照时间与距今时长；超过 24h 打「未重新检测」标（判定不变）', async () => {
    const counter = { calls: 0 };
    const { registry, engine } = buildEngine(counter);
    registerEslintRule(registry);

    const report = await engine.evaluateRules({
      repoRoot: '/tmp',
      conclusions: {
        inspect: { domain: 'inspect', generatedAt: '2026-01-01T00:00:00.000Z', issues: [] },
      },
    });

    const eval0 = report.evaluations[0];
    expect(counter.calls).toBe(0);
    expect(eval0.status).toBe('passed');
    expect(eval0.message).toContain('快照');
    expect(eval0.message).toContain('小时前');
    expect(eval0.message).toContain('未重新检测');
  });

  it('跨域归属的 guard 阻断规则在结论模式下仍按结论判定（不让位）', async () => {
    // 2026-11-11 归属审计发现 `guard.block.external.sensitive-info` 的 owner 是 security。
    // 门禁在结论模式下是消费 Owner 结论的「策略闸」，不是重扫；若被归属让位短路，
    // 门禁会静默丢掉这条跨域阻断项（这正是让位判据不能一刀切的原因）。
    const counter = { calls: 0 };
    const { registry, engine } = buildEngine(counter);
    registry.register(
      makeRule({
        id: 'guard.block.external.sensitive-info',
        domain: 'guard',
        severity: 'error',
        content: { check: { tool: 'gitleaks', severity: 'error' } },
      }),
    );

    const report = await engine.evaluateRules({
      repoRoot: '/tmp',
      conclusions: {
        security: { domain: 'security', generatedAt: new Date().toISOString(), issues: [] },
      },
    });

    const eval0 = report.evaluations[0];
    expect(counter.calls).toBe(0);
    expect(eval0.status).toBe('passed');
    expect(eval0.message).toContain('只读判定');
    expect(eval0.message).toContain('security 域');
  });

  it('新快照不打过期标（只回显距今年龄）', async () => {
    const counter = { calls: 0 };
    const { registry, engine } = buildEngine(counter);
    registerEslintRule(registry);

    const report = await engine.evaluateRules({
      repoRoot: '/tmp',
      conclusions: {
        inspect: { domain: 'inspect', generatedAt: new Date().toISOString(), issues: [] },
      },
    });

    expect(report.evaluations[0].status).toBe('passed');
    expect(report.evaluations[0].message).toContain('快照');
    expect(report.evaluations[0].message).not.toContain('未重新检测');
  });

  it('供应商域结论有同级问题 → failed，违规条目来自该域快照', async () => {
    const counter = { calls: 0 };
    const { registry, engine } = buildEngine(counter);
    registerEslintRule(registry);

    const report = await engine.evaluateRules({
      repoRoot: '/tmp',
      conclusions: {
        inspect: {
          domain: 'inspect',
          generatedAt: '2026-11-01T00:00:00.000Z',
          issues: [
            {
              ruleId: 'inspect.scan.official.eslint',
              severity: 'error',
              file: 'src/a.ts',
              line: 12,
              message: 'no-explicit-any',
            },
          ],
        },
      },
    });

    expect(counter.calls).toBe(0);
    const evaluation = report.evaluations[0];
    expect(evaluation.status).toBe('failed');
    expect(evaluation.violations).toHaveLength(1);
    expect(evaluation.violations?.[0].file).toBe('src/a.ts');
    expect(evaluation.files).toEqual(['src/a.ts']);
    expect(evaluation.message).toContain('inspect 域');
  });

  it('结论问题未达规则严重级，或属工具故障（toolError）→ passed', async () => {
    const counter = { calls: 0 };
    const { registry, engine } = buildEngine(counter);
    registerEslintRule(registry);

    const report = await engine.evaluateRules({
      repoRoot: '/tmp',
      conclusions: {
        inspect: {
          domain: 'inspect',
          generatedAt: '2026-11-01T00:00:00.000Z',
          issues: [
            {
              ruleId: 'inspect.scan.official.naming',
              severity: 'warning',
              file: 'src/b.ts',
              message: '命名建议',
            },
            {
              ruleId: 'inspect.scan.official.eslint',
              severity: 'error',
              file: 'src/c.ts',
              message: 'eslint 未安装',
              toolError: true,
            },
          ],
        },
      },
    });

    expect(counter.calls).toBe(0);
    expect(report.evaluations[0].status).toBe('passed');
  });
});
