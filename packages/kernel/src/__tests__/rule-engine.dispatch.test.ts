import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';
import type { ToolScanOptions } from '@zh/shared';

describe('SopRuleEngine — 派发评估（check-list / scanner-dispatch / tool-dispatch / preset）', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;
  let tempDir: string;

  beforeEach(() => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
    tempDir = mkdtempSync(path.join(tmpdir(), 'rule-engine-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('check-list: 派发到 GuardEngine', async () => {
    let guardCalled = false;
    const mockGuard = {
      run: async (opts: { mode: string; checks: string[] }) => {
        guardCalled = true;
        expect(opts.mode).toBe('guard');
        expect(opts.checks).toContain('guard.block.eslint-error');
        return {
          summary: { total: 1, passed: 0, failed: 1 },
          results: [{ status: 'failed', message: 'no-unused-vars found' }],
        };
      },
    };

    const engineWithGuard = new SopRuleEngine(registry, { guardEngine: mockGuard });
    registry.register(makeRule({
      id: 'guard.block.eslint-error',
      domain: 'guard',
      content: {
        checks: [{ rule: 'no-unused-vars', level: 'error' }],
      },
    }));

    const report = await engineWithGuard.evaluateRules({ repoRoot: '/tmp' });
    expect(report.total).toBe(1);
    expect(guardCalled).toBe(true);
    expect(report.evaluations[0].status).toBe('failed');
  });

  it('scanner-dispatch: 全部扫描器未注册时返回 skipped 并附原因（不再回退 InspectEngine）', async () => {
    let inspectCalled = false;
    const mockInspect = {
      runScan: async (_projectId: string) => {
        inspectCalled = true;
        return {
          summary: { total: 0, error: 0, warning: 0, info: 0 },
          score: { overall: 100, grade: 'A' },
          issues: [],
        };
      },
    };

    const engineWithInspect = new SopRuleEngine(registry, { inspectEngine: mockInspect });
    registry.register(makeRule({
      id: 'inspect.security.dependency-audit',
      domain: 'inspect',
      action: 'scan',
      applicableEngines: ['inspect'],
      content: { scanners: ['npm-audit', 'trivy'], schedule: 'daily' },
    }));

    const report = await engineWithInspect.evaluateRules({
      repoRoot: '/tmp',
      domain: 'inspect',
    });
    expect(report.total).toBe(1);
    expect(inspectCalled).toBe(false);
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('skipped');
    expect(evalResult.message).toContain('npm-audit');
    expect(evalResult.message).toContain('trivy');
    expect(evalResult.message).toContain('未注册');
  });

  it('scanner-dispatch: 扫描器不可用/未注册混合时返回 skipped 并逐项列出原因', async () => {
    const unavailableAdapter = {
      meta: { id: 'semgrep', name: 'Semgrep', category: 'security' as const, priority: 'P1' as const, installMode: 'external' as const, description: '', cliCommand: '', homepage: '', license: '' },
      isAvailable: async () => false,
      scan: async () => { throw new Error('should not be called'); },
    };

    const engineWithAdapters = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'semgrep', adapter: unavailableAdapter }],
    });

    registry.register(makeRule({
      id: 'inspect.security.semgrep-scan',
      domain: 'inspect',
      action: 'scan',
      applicableEngines: ['inspect'],
      content: { scanners: ['semgrep', 'gitleaks'] },
    }));

    const report = await engineWithAdapters.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('skipped');
    expect(evalResult.message).toContain('semgrep');
    expect(evalResult.message).toContain('gitleaks');
    expect(evalResult.message).toContain('未安装或在 PATH 中未找到');
    expect(evalResult.message).toContain('未注册');
  });

  it('scanner-dispatch: 至少一个扫描器可用且零违规时仍为 passed', async () => {
    const availableAdapter = {
      meta: { id: 'semgrep', name: 'Semgrep', category: 'security' as const, priority: 'P1' as const, installMode: 'external' as const, description: '', cliCommand: '', homepage: '', license: '' },
      isAvailable: async () => true,
      scan: async () => ({
        tool: 'semgrep' as const,
        status: 'available' as const,
        issues: [],
        metadata: { version: '', duration: 10, timestamp: new Date(), fileCount: 0 },
      }),
    };

    const engineWithAdapters = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'semgrep', adapter: availableAdapter }],
    });

    registry.register(makeRule({
      id: 'inspect.security.semgrep-scan',
      domain: 'inspect',
      action: 'scan',
      applicableEngines: ['inspect'],
      content: { scanners: ['semgrep', 'gitleaks'] },
    }));

    const report = await engineWithAdapters.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('passed');
    expect(report.passed).toBe(1);
  });

  it('GuardEngine 未注册时 check-list 返回 skipped', async () => {
    registry.register(makeRule({
      id: 'guard.block.eslint-error',
      domain: 'guard',
      content: { checks: [{ rule: 'no-console', level: 'warn' }] },
    }));

    const report = await engine.evaluateRules({ repoRoot: '/tmp' });
    expect(report.total).toBe(1);
    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].message).toContain('GuardEngine 未注册');
  });

  it('tool-dispatch: 注册 mock 适配器后正确执行', async () => {
    let scanCalled = false;
    const mockAdapter = {
      meta: { id: 'eslint', name: 'ESLint', category: 'guard' as const, priority: 'P1' as const, installMode: 'builtin' as const, description: '', cliCommand: '', homepage: '', license: '' },
      isAvailable: async () => true,
      scan: async (opts: ToolScanOptions) => {
        scanCalled = true;
        expect(opts.projectPath).toBe('/test-project');
        expect(opts.config?.configFile).toBe('.eslintrc.cjs');
        return {
          tool: 'eslint' as const,
          status: 'available' as const,
          issues: [],
          metadata: { version: '', duration: 10, timestamp: new Date(), fileCount: 0 },
        };
      },
    };

    const e2eEngine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: mockAdapter }],
    });

    registry.register(makeRule({
      id: 'guard.block.external.eslint-error',
      domain: 'guard',
      action: 'block',
      severity: 'high',
      content: {
        metadata: { id: 'guard.block.external.eslint-error', name: 'ESLint Error' },
        governance: { domain: 'guard', action: 'block' },
        check: { tool: 'eslint', toolConfig: { configFile: '.eslintrc.cjs' } },
      },
    }));

    const report = await e2eEngine.evaluateRules({
      repoRoot: '/test-project',
      domain: 'guard',
    });
    expect(scanCalled).toBe(true);
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
  });

  it('tool-dispatch: 未注册适配器时返回 skipped', async () => {
    registry.register(makeRule({
      id: 'guard.block.test-missing-adapter',
      domain: 'guard',
      content: {
        check: { tool: 'nonexistent-tool', toolConfig: {} },
      },
    }));

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'guard' });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('skipped');
    expect(evalResult.message).toContain('未注册');
  });

  it('tool-dispatch: 适配器 isAvailable=false 时返回 skipped', async () => {
    const unavailableAdapter = {
      meta: { id: 'broken-tool', name: 'Broken', category: 'guard' as const, priority: 'P1' as const, installMode: 'builtin' as const, description: '', cliCommand: '', homepage: '', license: '' },
      isAvailable: async () => false,
      scan: async () => { throw new Error('should not be called'); },
    };

    const unavailableEngine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'broken-tool', adapter: unavailableAdapter }],
    });

    registry.register(makeRule({
      id: 'guard.block.test-unavailable',
      domain: 'guard',
      content: { check: { tool: 'broken-tool', toolConfig: {} } },
    }));

    const report = await unavailableEngine.evaluateRules({ repoRoot: '/tmp', domain: 'guard' });
    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].message).toContain('不可用');
  });

  it('tool-dispatch: scan() 返回 unavailable 时映射为 skipped（如注入 config 缺失）', async () => {
    const unavailableScanAdapter = {
      meta: { id: 'eslint', name: 'ESLint', category: 'guard' as const, priority: 'P1' as const, installMode: 'builtin' as const, description: '', cliCommand: '', homepage: '', license: '' },
      isAvailable: async () => true,
      scan: async () => ({
        tool: 'eslint' as const,
        status: 'unavailable' as const,
        issues: [],
        metadata: { version: '', duration: 10, timestamp: new Date(), fileCount: 0 },
        error: 'ESLint 性能配置不存在，跳过该规则',
      }),
    };

    const e2eEngine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: unavailableScanAdapter }],
    });

    registry.register(makeRule({
      id: 'inspect.scan.official.eslint-performance',
      domain: 'inspect',
      action: 'scan',
      applicableEngines: ['inspect'],
      content: { check: { tool: 'eslint', toolConfig: { config: 'node_modules/@zh/kernel/dist/assets/eslint/eslint-performance.config.mjs' } } },
    }));

    const report = await e2eEngine.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('skipped');
    expect(report.skipped).toBe(1);
  });

  it('tool-dispatch: scan() 抛出异常时返回 error', async () => {
    const errorAdapter = {
      meta: { id: 'error-tool', name: 'ErrorTool', category: 'guard' as const, priority: 'P1' as const, installMode: 'builtin' as const, description: '', cliCommand: '', homepage: '', license: '' },
      isAvailable: async () => true,
      scan: async () => { throw new Error('CLI crashed'); },
    };

    const errorEngine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'error-tool', adapter: errorAdapter }],
    });

    registry.register(makeRule({
      id: 'guard.block.test-error',
      domain: 'guard',
      content: { check: { tool: 'error-tool', toolConfig: {} } },
    }));

    const report = await errorEngine.evaluateRules({ repoRoot: '/tmp', domain: 'guard' });
    expect(report.evaluations[0].status).toBe('error');
    expect(report.evaluations[0].message).toContain('CLI crashed');
  });

  it('preset 派发不得导致 evaluateRules 无限递归', async () => {
    let scanCalls = 0;
    const inspectEngine = {
      runScan: async (projectId: string) => {
        scanCalls += 1;
        // 模拟 InspectEngine.runScanWithSop：再次进入规则引擎
        await engine.evaluateRules({ repoRoot: projectId, domain: 'inspect' });
        return { summary: { total: 0 } };
      },
    };

    engine = new SopRuleEngine(registry, { inspectEngine });

    registry.register(makeRule({
      id: 'guard.block.eslint-error',
      domain: 'guard',
      content: { presets: ['error-rules'] },
    }));
    registry.register(makeRule({
      id: 'inspect.scan.eslint-rules',
      domain: 'inspect',
      applicableEngines: ['inspect'],
      content: { presets: ['recommended'] },
    }));

    const report = await Promise.race([
      engine.runGuard({ repoRoot: tempDir }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('reentrancy timeout — infinite loop')), 5000),
      ),
    ]);

    expect(report.total).toBeGreaterThan(0);
    // 无 eslint adapter 时外层 preset 会走一次 runScan；嵌套 preset 必须被跳过
    expect(scanCalls).toBeLessThanOrEqual(1);
    const nested = report.evaluations.find((e) => e.rule.id === 'guard.block.eslint-error');
    expect(nested).toBeDefined();
  });
});
