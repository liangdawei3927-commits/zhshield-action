import { describe, it, expect, beforeEach } from 'vitest';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';
import type { ToolScanOptions } from '@zh/shared';

/**
 * R3d 执行面投影激活：SOP tool-dispatch 按画像裁剪（dispatch-evaluators.ts L208 toolScope 分支）。
 * 此前该分支零覆盖——生产调用方从不传 context.projectFeature → host.toolScope 恒 undefined → 永不触发。
 * 本组用例直接以 context.projectFeature 驱动三分支：未命中（裁）/ 命中（不裁）/ 无画像（不裁）。
 * 语义与 shared isToolInScope 一致：eslint 仅 language ∈ {typescript, javascript} 时在 scope。
 */
describe('SopRuleEngine — R3d tool-dispatch 画像 scope 裁剪（dispatch-evaluators toolScope 分支）', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;

  const eslintAdapter = {
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
    engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: eslintAdapter }],
    });
    registry.register(
      makeRule({
        id: 'guard.block.eslint-error',
        domain: 'guard',
        content: { check: { tool: 'eslint', toolConfig: {} } },
      }),
    );
  });

  it('① toolScope 未命中（画像 language=go，eslint 不在 scope）→ 指令 skipped + reason 含「不在当前项目画像 scope」', async () => {
    const report = await engine.evaluateRules({
      repoRoot: '/tmp',
      domain: 'guard',
      projectFeature: { language: 'go', features: [] },
    });

    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('skipped');
    expect(evalResult.message).toContain('不在当前项目画像 scope');
    expect(report.skipped).toBe(1);
  });

  it('② toolScope 命中（画像 language=typescript，eslint 在 scope）→ 正常执行 passed', async () => {
    const report = await engine.evaluateRules({
      repoRoot: '/tmp',
      domain: 'guard',
      projectFeature: { language: 'typescript', features: [] },
    });

    expect(report.evaluations[0].status).toBe('passed');
    expect(report.passed).toBe(1);
  });

  it('③ 无画像（不传 projectFeature）→ toolScope undefined → 不裁剪，正常执行', async () => {
    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'guard' });

    expect(report.evaluations[0].status).toBe('passed');
    expect(report.passed).toBe(1);
  });
});