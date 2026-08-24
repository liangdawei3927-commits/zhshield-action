// F0-3 验收测试：三个注册入口的 wrapAdapter 接线
// 覆盖 SopRuleEngine.registerToolAdapter（kernel）与 InspectEngine.registerAdapter（inspect）。
// SecurityEngine.registerAdapter 无法在本文件覆盖：仓库依赖方向禁止引擎互引，
// 且仅 desktop/server 依赖 @zh/security（其接线与 inspect 完全同构的一行 wrapAdapter）。

import { describe, it, expect } from 'vitest';
import { InspectEngine } from '../engine';
import { SopRuleEngine, SopRegistry } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';
import type { ToolAdapter, ToolCallHook, ToolId, ToolResult, ToolScanOptions } from '@zh/shared';

interface CountingAdapter {
  adapter: ToolAdapter;
  calls: ToolScanOptions[];
  result: ToolResult;
}

function makeCountingAdapter(id: ToolId): CountingAdapter {
  const calls: ToolScanOptions[] = [];
  const result: ToolResult = {
    tool: id,
    status: 'available',
    issues: [],
    metadata: { version: 'test', duration: 1, timestamp: new Date(), fileCount: 0 },
  };
  const adapter: ToolAdapter = {
    meta: {
      id,
      name: id,
      category: 'guard',
      priority: 'P1',
      installMode: 'builtin',
      description: '',
      cliCommand: id,
      homepage: '',
      license: '',
    },
    isAvailable: async () => true,
    scan: async (options) => {
      calls.push(options);
      return result;
    },
  };
  return { adapter, calls, result };
}

function makeToolDispatchRule(tool: ToolId): SopRule {
  return {
    id: `guard.block.wiring-${tool}`,
    name: 'wiring-test-rule',
    domain: 'guard',
    action: 'block',
    source: 'official',
    description: '',
    status: 'active',
    executionMode: 'sync',
    severity: 'high',
    applicableEngines: ['guard'],
    content: { check: { tool, toolConfig: {} } },
    tags: [],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('F0-3 适配器注册接线（wrapAdapter 纯透传）', () => {
  it('SopRuleEngine.registerToolAdapter：零钩子时经 tool-dispatch 扫描透传，底层适配器恰好执行一次', async () => {
    const fake = makeCountingAdapter('eslint');
    const registry = new SopRegistry();
    const engine = new SopRuleEngine(registry);
    engine.registerToolAdapter('eslint', fake.adapter);
    registry.register(makeToolDispatchRule('eslint'));

    const report = await engine.evaluateRules({ repoRoot: '/test-project', domain: 'guard' });

    expect(fake.calls).toHaveLength(1);
    expect(report.passed).toBe(1);
  });

  it('SopRuleEngine 构造器 toolAdapters 入口：零钩子透传，底层适配器恰好执行一次', async () => {
    const fake = makeCountingAdapter('semgrep');
    const registry = new SopRegistry();
    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'semgrep', adapter: fake.adapter }],
    });
    registry.register(makeToolDispatchRule('semgrep'));

    const report = await engine.evaluateRules({ repoRoot: '/test-project', domain: 'guard' });

    expect(fake.calls).toHaveLength(1);
    expect(report.passed).toBe(1);
  });

  it('SopRuleEngine 注入 hooks：before 改写 scan options 后底层适配器收到改写值', async () => {
    const fake = makeCountingAdapter('eslint');
    const hook: ToolCallHook = {
      before: (_adapter, options) => ({
        ...options,
        config: { enabled: true, flags: ['mutated-by-hook'] },
      }),
      after: (_adapter, result) => result,
    };
    const registry = new SopRegistry();
    const engine = new SopRuleEngine(registry, { hooks: [hook] });
    engine.registerToolAdapter('eslint', fake.adapter);
    registry.register(makeToolDispatchRule('eslint'));

    const report = await engine.evaluateRules({ repoRoot: '/test-project', domain: 'guard' });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.config?.flags).toEqual(['mutated-by-hook']);
    expect(report.passed).toBe(1);
  });

  it('InspectEngine.registerAdapter：注册成功且 runScan 全链路透传，底层适配器恰好执行一次', async () => {
    const fake = makeCountingAdapter('eslint');
    const engine = new InspectEngine();
    engine.registerAdapter(fake.adapter);
    expect(() => engine.getToolManager().get('eslint')).not.toThrow();

    const report = await engine.runScan('proj-wiring');

    expect(fake.calls).toHaveLength(1);
    expect(report.adapterResults).toHaveLength(1);
    expect(report.adapterResults[0]?.passed).toBe(true);
  });

  it('inspect → sop 转发链：适配器被嵌套包装两层仍只执行一次（嵌套无害）', async () => {
    const fake = makeCountingAdapter('eslint');
    const registry = new SopRegistry();
    const sop = new SopRuleEngine(registry);
    const inspect = new InspectEngine();
    inspect.useSopEngine(sop);
    inspect.registerAdapter(fake.adapter);
    registry.register(makeToolDispatchRule('eslint'));

    const report = await sop.evaluateRules({ repoRoot: '/test-project', domain: 'guard' });

    expect(fake.calls).toHaveLength(1);
    expect(report.passed).toBe(1);
  });
});
