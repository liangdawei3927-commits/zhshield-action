import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { AuditLogger } from '@zh/shared';
import type { ToolAdapter, ToolResult, ToolScanOptions } from '@zh/shared';
import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

/** 构造固定返回结果的 mock ToolAdapter（eslint），可覆盖部分 ToolResult 字段 */
function makeFakeAdapter(resultOverrides?: Partial<ToolResult>): ToolAdapter {
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
      issues: [],
      metadata: { version: '', duration: 12, timestamp: new Date(), fileCount: 3 },
      ...resultOverrides,
    }),
  };
}

function registerDispatchRule(registry: SopRegistry, tool: string): void {
  registry.register(
    makeRule({
      id: `guard.block.external.${tool}`,
      domain: 'guard',
      action: 'block',
      severity: 'high',
      content: {
        check: { tool, toolConfig: {} },
      },
    }),
  );
}

describe('tool-dispatch 审计（F0-4）— kernel SOP 派发扫描补记 audit log', () => {
  let registry: SopRegistry;

  beforeEach(() => {
    registry = new SopRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Given 已注册适配器的 tool-dispatch 规则 When evaluateRules 成功 Then logToolExecution 记录 adapter id 与 status', async () => {
    const spy = vi.spyOn(AuditLogger.prototype, 'logToolExecution').mockResolvedValue(undefined);
    const engine = new SopRuleEngine(registry);
    engine.registerToolAdapter('eslint', makeFakeAdapter());
    registerDispatchRule(registry, 'eslint');

    const report = await engine.evaluateRules({ repoRoot: '/test-project', domain: 'guard' });

    expect(report.passed).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const entry = spy.mock.calls[0]?.[0];
    if (!entry) throw new Error('logToolExecution 未被调用');
    expect(entry.tool).toBe('eslint');
    expect(entry.status).toBe('available');
    expect(entry.projectId).toBe('/test-project');
    expect(entry.issueCount).toBe(0);
    expect(entry.fileCount).toBe(3);
    expect(typeof entry.duration).toBe('number');
  });

  it('Given 审计写入抛错 When evaluateRules Then 扫描结果仍为 passed（审计失败不污染结果）', async () => {
    vi.spyOn(AuditLogger.prototype, 'logToolExecution').mockRejectedValue(new Error('disk full'));
    const engine = new SopRuleEngine(registry);
    engine.registerToolAdapter('eslint', makeFakeAdapter());
    registerDispatchRule(registry, 'eslint');

    const report = await engine.evaluateRules({ repoRoot: '/test-project', domain: 'guard' });

    expect(report.evaluations[0]?.status).toBe('passed');
    expect(report.ok).toBe(true);
  });

  it('Given 适配器未注册（skipped 路径）When evaluateRules Then 不产生审计', async () => {
    const spy = vi.spyOn(AuditLogger.prototype, 'logToolExecution').mockResolvedValue(undefined);
    const engine = new SopRuleEngine(registry);
    registerDispatchRule(registry, 'nonexistent-tool');

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'guard' });

    expect(report.evaluations[0]?.status).toBe('skipped');
    expect(spy).not.toHaveBeenCalled();
  });
});
