import { describe, it, expect, beforeEach } from 'vitest';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';
import type { ToolScanOptions } from '@zh/shared';

/**
 * 工程缺口：SOP tool-dispatch 派发路径（dispatch-evaluators.ts executeToolScan）此前无硬超时兜底，
 * 网络受限 / 异常工具（如 trivy 联网下载漏洞库被阻断）会无限挂起整个体检（实测卡死 >10min）。
 * InspectEngine 层 ToolAdapterExecutor 已有 withHardTimeout（默认 120s），本组用例验证 SOP 派发路径对齐补齐。
 */
describe('SopRuleEngine — tool-dispatch 工具扫描硬超时兜底', () => {
  let registry: SopRegistry;

  const hangingAdapter = {
    meta: {
      id: 'eslint',
      name: 'ESLint',
      category: 'guard' as const,
      priority: 'P1' as const,
      installMode: 'builtin' as const,
      description: '',
      cliCommand: '',
      homepage: '',
      license: '',
    },
    isAvailable: async () => true,
    // 永不 settle：模拟进程挂起的异常工具
    scan: async () => new Promise<never>(() => {}),
  };

  const fastAdapter = {
    meta: {
      id: 'eslint',
      name: 'ESLint',
      category: 'guard' as const,
      priority: 'P1' as const,
      installMode: 'builtin' as const,
      description: '',
      cliCommand: '',
      homepage: '',
      license: '',
    },
    isAvailable: async () => true,
    scan: async (_opts: ToolScanOptions) => ({
      tool: 'eslint' as const,
      status: 'available' as const,
      issues: [],
      metadata: { version: '', duration: 10, timestamp: new Date(), fileCount: 0 },
    }),
  };

  beforeEach(() => {
    registry = new SopRegistry();
  });

  it('① 工具挂起超过硬上限 → 评估 error + 消息含超时原因（短路返回，不再无限挂起体检）', async () => {
    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: hangingAdapter }],
      toolScanTimeoutMs: 50,
    });
    registry.register(
      makeRule({
        id: 'guard.block.eslint-error',
        domain: 'guard',
        content: { check: { tool: 'eslint', toolConfig: {} } },
      }),
    );

    const start = Date.now();
    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'guard' });
    const elapsed = Date.now() - start;

    expect(report.total).toBe(1);
    expect(report.errors).toBe(1);
    expect(report.evaluations[0].status).toBe('error');
    expect(report.evaluations[0].message).toContain('硬上限');
    // 50ms 超时下应快速返回，而非无限挂起
    expect(elapsed).toBeLessThan(2000);
  });

  it('② 工具在超时内正常返回 → passed（超时兜底不误伤正常工具）', async () => {
    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: fastAdapter }],
      toolScanTimeoutMs: 500,
    });
    registry.register(
      makeRule({
        id: 'guard.block.eslint-error',
        domain: 'guard',
        content: { check: { tool: 'eslint', toolConfig: {} } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'guard' });

    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.evaluations[0].status).toBe('passed');
    expect(report.evaluations[0].message).toContain('检查通过');
  });

  it('③ 未配置 toolScanTimeoutMs → 使用缺省值，正常工具仍通过（缺省注入路径不破坏既有行为）', async () => {
    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: fastAdapter }],
    });
    registry.register(
      makeRule({
        id: 'guard.block.eslint-error',
        domain: 'guard',
        content: { check: { tool: 'eslint', toolConfig: {} } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'guard' });

    expect(report.passed).toBe(1);
    expect(report.evaluations[0].status).toBe('passed');
  });
});
