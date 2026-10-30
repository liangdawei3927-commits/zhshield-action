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
    registry.register(
      makeRule({
        id: 'guard.block.eslint-error',
        domain: 'guard',
        content: {
          checks: [{ rule: 'no-unused-vars', level: 'error' }],
        },
      }),
    );

    const report = await engineWithGuard.evaluateRules({ repoRoot: '/tmp' });
    expect(report.total).toBe(1);
    expect(guardCalled).toBe(true);
    expect(report.evaluations[0].status).toBe('failed');
  });

  it('check-list: 非 guard 域不再借调 GuardEngine，显式说明「无执行器」', async () => {
    // 回归：inspect.scan.official.type-consistency / null-safety 这类云壳规则
    // content 只有 checks（声明的检查项无任何引擎实现）。旧实现把它们派发给
    // GuardEngine.run → 带 SOP 引擎时重入 evaluateRules 全量评估 guard 域并按
    // options.checks 过滤 → 过滤不到就得到空结果集 → 「Guard 检查通过」（假通过）；
    // 并行时又被 evalDepth 漂移判成「防止规则引擎重入」（未检查）。两者皆假象。
    let guardCalled = false;
    const mockGuard = {
      run: async () => {
        guardCalled = true;
        return { summary: { total: 0, passed: 0, failed: 0 }, results: [] };
      },
    };

    const engineWithGuard = new SopRuleEngine(registry, { guardEngine: mockGuard });
    registry.register(
      makeRule({
        id: 'inspect.scan.official.type-consistency',
        domain: 'inspect',
        content: { checks: ['no-implicit-any', 'no-type-assertion'] },
      }),
    );

    const report = await engineWithGuard.evaluateRules({ repoRoot: '/tmp' });
    expect(guardCalled).toBe(false);
    expect(report.evaluations[0].status).toBe('skipped');
    // 非 degraded：这是「规则本身没有实现」，不是运行时工具不可用 ⇒ 不应阻断体检
    expect(report.evaluations[0].degraded).toBeUndefined();
    expect(report.evaluations[0].message).toContain('无 check-list 执行器');
    expect(report.evaluations[0].message).toContain('no-implicit-any');
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
    registry.register(
      makeRule({
        id: 'inspect.security.dependency-audit',
        domain: 'inspect',
        action: 'scan',
        applicableEngines: ['inspect'],
        content: { scanners: ['npm-audit', 'trivy'], schedule: 'daily' },
      }),
    );

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
      meta: {
        id: 'semgrep',
        name: 'Semgrep',
        category: 'security' as const,
        priority: 'P1' as const,
        installMode: 'external' as const,
        description: '',
        cliCommand: '',
        homepage: '',
        license: '',
      },
      isAvailable: async () => false,
      scan: async () => {
        throw new Error('should not be called');
      },
    };

    const engineWithAdapters = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'semgrep', adapter: unavailableAdapter }],
    });

    registry.register(
      makeRule({
        id: 'inspect.security.semgrep-scan',
        domain: 'inspect',
        action: 'scan',
        applicableEngines: ['inspect'],
        content: { scanners: ['semgrep', 'gitleaks'] },
      }),
    );

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
      meta: {
        id: 'semgrep',
        name: 'Semgrep',
        category: 'security' as const,
        priority: 'P1' as const,
        installMode: 'external' as const,
        description: '',
        cliCommand: '',
        homepage: '',
        license: '',
      },
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

    registry.register(
      makeRule({
        id: 'inspect.security.semgrep-scan',
        domain: 'inspect',
        action: 'scan',
        applicableEngines: ['inspect'],
        content: { scanners: ['semgrep', 'gitleaks'] },
      }),
    );

    const report = await engineWithAdapters.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('passed');
    expect(report.passed).toBe(1);
  });

  it('GuardEngine 未注册时 check-list 返回 skipped', async () => {
    registry.register(
      makeRule({
        id: 'guard.block.eslint-error',
        domain: 'guard',
        content: { checks: [{ rule: 'no-console', level: 'warn' }] },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp' });
    expect(report.total).toBe(1);
    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].message).toContain('GuardEngine 未注册');
  });

  it('tool-dispatch: 注册 mock 适配器后正确执行', async () => {
    let scanCalled = false;
    const mockAdapter = {
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
      scan: async (opts: ToolScanOptions) => {
        scanCalled = true;
        expect(opts.projectPath).toBe('/test-project');
        expect(opts.config?.config).toBe('.eslintrc.cjs');
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

    registry.register(
      makeRule({
        id: 'guard.block.external.eslint-error',
        domain: 'guard',
        action: 'block',
        severity: 'high',
        content: {
          metadata: { id: 'guard.block.external.eslint-error', name: 'ESLint Error' },
          governance: { domain: 'guard', action: 'block' },
          check: { tool: 'eslint', toolConfig: { configFile: '.eslintrc.cjs' } },
        },
      }),
    );

    const report = await e2eEngine.evaluateRules({
      repoRoot: '/test-project',
      domain: 'guard',
    });
    expect(scanCalled).toBe(true);
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
  });

  it('tool-dispatch: 未注册适配器时返回 skipped', async () => {
    registry.register(
      makeRule({
        id: 'guard.block.test-missing-adapter',
        domain: 'guard',
        content: {
          check: { tool: 'nonexistent-tool', toolConfig: {} },
        },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'guard' });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('skipped');
    expect(evalResult.message).toContain('未注册');
  });

  it('tool-dispatch: 适配器 isAvailable=false 时返回 skipped', async () => {
    const unavailableAdapter = {
      meta: {
        id: 'broken-tool',
        name: 'Broken',
        category: 'guard' as const,
        priority: 'P1' as const,
        installMode: 'builtin' as const,
        description: '',
        cliCommand: '',
        homepage: '',
        license: '',
      },
      isAvailable: async () => false,
      scan: async () => {
        throw new Error('should not be called');
      },
    };

    const unavailableEngine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'broken-tool', adapter: unavailableAdapter }],
    });

    registry.register(
      makeRule({
        id: 'guard.block.test-unavailable',
        domain: 'guard',
        content: { check: { tool: 'broken-tool', toolConfig: {} } },
      }),
    );

    const report = await unavailableEngine.evaluateRules({ repoRoot: '/tmp', domain: 'guard' });
    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].message).toContain('不可用');
  });

  it('tool-dispatch: scan() 返回 unavailable 时映射为 skipped（如注入 config 缺失）', async () => {
    const unavailableScanAdapter = {
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

    registry.register(
      makeRule({
        id: 'inspect.scan.official.eslint-performance',
        domain: 'inspect',
        action: 'scan',
        applicableEngines: ['inspect'],
        content: {
          check: {
            tool: 'eslint',
            toolConfig: {
              config: 'node_modules/@zh/kernel/dist/assets/eslint/eslint-performance.config.mjs',
            },
          },
        },
      }),
    );

    const report = await e2eEngine.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('skipped');
    expect(report.skipped).toBe(1);
  });

  it('tool-dispatch: scan() 抛出异常时返回 error', async () => {
    const errorAdapter = {
      meta: {
        id: 'error-tool',
        name: 'ErrorTool',
        category: 'guard' as const,
        priority: 'P1' as const,
        installMode: 'builtin' as const,
        description: '',
        cliCommand: '',
        homepage: '',
        license: '',
      },
      isAvailable: async () => true,
      scan: async () => {
        throw new Error('CLI crashed');
      },
    };

    const errorEngine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'error-tool', adapter: errorAdapter }],
    });

    registry.register(
      makeRule({
        id: 'guard.block.test-error',
        domain: 'guard',
        content: { check: { tool: 'error-tool', toolConfig: {} } },
      }),
    );

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

    registry.register(
      makeRule({
        id: 'guard.block.eslint-error',
        domain: 'guard',
        content: { presets: ['error-rules'] },
      }),
    );
    registry.register(
      makeRule({
        id: 'inspect.scan.eslint-rules',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { presets: ['recommended'] },
      }),
    );

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

  it('security check-list: 全部检测项确知不适用时，规则标为 not-applicable 且不计入通过', async () => {
    // 业务意图：「没得查」不等于「查过且安全」。无 Web 框架的项目没有装配
    // Helmet/CSRF 的位置，若仍算 passed，报告会虚增一条「已验证的安全能力」。
    const mockSecurity = {
      run: async () => ({
        results: [
          {
            status: 'passed',
            applicability: 'not-applicable',
            message: 'helmet-configured: 项目未使用 Web 框架，检查不适用',
          },
          {
            status: 'passed',
            applicability: 'not-applicable',
            message: 'csrf-token-present: 项目未使用 Web 框架，检查不适用',
          },
        ],
      }),
    };

    const engineWithSecurity = new SopRuleEngine(registry, {
      securityCheckEngine: mockSecurity,
    });
    registry.register(
      makeRule({
        id: 'security.web.helmet-check',
        domain: 'security',
        content: {
          checks: [
            { rule: 'helmet-configured', level: 'error' },
            { rule: 'csrf-token-present', level: 'error' },
          ],
        },
      }),
    );

    const report = await engineWithSecurity.evaluateRules({
      repoRoot: tempDir,
      domain: 'security',
    });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('passed');
    expect(evalResult.applicability).toBe('not-applicable');
    expect(evalResult.message).toContain('未使用 Web 框架');
    // 聚合口径：passed 不包含不适用项，notApplicable 单列
    expect(report.passed).toBe(0);
    expect(report.notApplicable).toBe(1);
    // 不适用不构成失败，也不制造降级护栏
    expect(report.ok).toBe(true);
    expect(report.degraded).toBe(0);
  });

  it('security check-list: 只有一个检测项不适用时，规则仍按普通结果判定', async () => {
    // 混合场景（部分可检）表示规则确实被执行过——不能整条标为不适用。
    const mockSecurity = {
      run: async () => ({
        results: [
          {
            status: 'passed',
            applicability: 'not-applicable',
            message: 'helmet-configured: 项目未使用 Web 框架，检查不适用',
          },
          { status: 'passed', message: 'csrf-token-present: 检测到防护证据' },
        ],
      }),
    };

    const engineWithSecurity = new SopRuleEngine(registry, {
      securityCheckEngine: mockSecurity,
    });
    registry.register(
      makeRule({
        id: 'security.web.mixed-check',
        domain: 'security',
        content: {
          checks: [
            { rule: 'helmet-configured', level: 'error' },
            { rule: 'csrf-token-present', level: 'error' },
          ],
        },
      }),
    );

    const report = await engineWithSecurity.evaluateRules({
      repoRoot: tempDir,
      domain: 'security',
    });
    const evalResult = report.evaluations[0];
    expect(evalResult.status).toBe('passed');
    expect(evalResult.applicability).toBeUndefined();
    expect(report.passed).toBe(1);
    expect(report.notApplicable).toBe(0);
  });
});
