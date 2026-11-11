import { describe, it, expect, beforeEach } from 'vitest';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';
import type { ToolScanOptions } from '@zh/shared';

/**
 * R7：工具自报 `skipReason: 'out-of-scope'` 时不得算降级。
 *
 * 实机（2026-11-11，文档仓库）：depcheck 的两条未使用依赖规则每轮都落 degraded，
 * 原因只是「扫描根无 package.json」——这是项目前提不满足（既定裁剪），不是工具故障。
 * 混进 degraded 会让「本项不适用」被渲染成「工具坏了」，给出错误的恢复指引。
 */
describe('SopRuleEngine — out-of-scope 不算降级（R7）', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;

  const outOfScopeAdapter = {
    meta: {
      id: 'depcheck',
      name: 'Depcheck',
      category: 'inspect' as const,
      priority: 'P1' as const,
      installMode: 'builtin' as const,
      description: '',
      cliCommand: '',
      homepage: '',
      license: '',
    },
    isAvailable: async () => true,
    scan: async (_opts: ToolScanOptions) => ({
      tool: 'depcheck' as const,
      status: 'unavailable' as const,
      skipReason: 'out-of-scope' as const,
      issues: [],
      error: '扫描根目录无 package.json，未使用依赖检测范围外未执行',
      metadata: { version: '', duration: 1, timestamp: new Date(), fileCount: 0 },
    }),
  };

  beforeEach(() => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'depcheck', adapter: outOfScopeAdapter }],
    });
  });

  it('scanners 形态：out-of-scope → skipped 且不标 degraded', async () => {
    registry.register(
      makeRule({
        id: 'security.scan.internal.unused-dependency',
        domain: 'security',
        applicableEngines: ['security'],
        content: { check: { scanners: ['depcheck'] } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'security' });
    const evaluation = report.evaluations[0];

    expect(evaluation.status).toBe('skipped');
    expect(evaluation.degraded).toBeUndefined();
    expect(report.degraded ?? 0).toBe(0);
  });
});
