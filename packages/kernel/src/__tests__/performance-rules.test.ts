import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine, ContentInterpreter } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import type { ToolScanOptions } from '@zh/shared';

/**
 * 性能检测规则包（packages/kernel/src/sop/inspect/scan/performance/）：
 * 验证两条规则从文件系统正确加载、解释为 tool-dispatch、且 toolConfig.config
 * 原样透传给对应工具适配器（ESLint 性能配置 / Semgrep ReDoS 规则文件）。
 */
describe('SOP 性能检测规则包', () => {
  let registry: SopRegistry;
  let loader: SopLoader;
  let tempDir: string;

  beforeEach(() => {
    registry = new SopRegistry();
    loader = new SopLoader(registry);
    tempDir = mkdtempSync(path.join(tmpdir(), 'perf-rule-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('从文件系统加载 eslint-performance 规则并解释为 tool-dispatch', async () => {
    const count = await loader.loadFromFileSystem();
    expect(count).toBeGreaterThan(0);

    const rule = registry.get('inspect.scan.official.eslint-performance');
    expect(rule).toBeDefined();
    expect(rule!.domain).toBe('inspect');
    expect(rule!.action).toBe('scan');
    expect(rule!.tags).toContain('performance');
    expect(rule!.tags).toContain('eslint');

    const instr = new ContentInterpreter().interpret(rule!);
    expect(instr.type).toBe('tool-dispatch');
    if (instr.type === 'tool-dispatch') {
      expect(instr.tool).toBe('eslint');
      expect(instr.toolConfig?.config).toContain('eslint-performance.config.mjs');
      expect(instr.toolConfig?.category).toBe('performance');
      expect(instr.conditions?.languages).toContain('typescript');
    }
  });

  it('从文件系统加载 semgrep-redos 规则并解释为 tool-dispatch', async () => {
    await loader.loadFromFileSystem();

    const rule = registry.get('inspect.scan.official.semgrep-redos');
    expect(rule).toBeDefined();
    expect(rule!.domain).toBe('inspect');
    expect(rule!.action).toBe('scan');
    expect(rule!.tags).toContain('semgrep');

    const instr = new ContentInterpreter().interpret(rule!);
    expect(instr.type).toBe('tool-dispatch');
    if (instr.type === 'tool-dispatch') {
      expect(instr.tool).toBe('semgrep');
      expect(instr.toolConfig?.config).toContain('redos.yml');
      expect(instr.toolConfig?.category).toBe('performance');
    }
  });

  it('tool-dispatch 将 toolConfig.config 透传给 ESLint 适配器', async () => {
    await loader.loadFromFileSystem();

    // preset 规则（eslint-rules.yml）也会派发 eslint（空 toolConfig），需按调用捕获
    const receivedConfigs: Array<Record<string, unknown> | undefined> = [];
    const mockAdapter = {
      meta: {
        id: 'eslint', name: 'ESLint', category: 'inspect' as const, priority: 'P0' as const,
        installMode: 'builtin' as const, description: '', cliCommand: 'eslint', homepage: '', license: '',
      },
      isAvailable: async () => true,
      scan: async (opts: ToolScanOptions) => {
        receivedConfigs.push(opts.config);
        return {
          tool: 'eslint' as const,
          status: 'available' as const,
          issues: [],
          metadata: { version: '', duration: 10, timestamp: new Date(), fileCount: 0 },
        };
      },
    };

    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: mockAdapter }],
    });

    const report = await engine.evaluateRules({ repoRoot: '/test-project', domain: 'inspect' });
    const evalResult = report.evaluations.find((e) => e.rule.id === 'inspect.scan.official.eslint-performance');
    expect(evalResult).toBeDefined();
    expect(evalResult!.status).toBe('passed');

    const perfCall = receivedConfigs.find((c) => c?.config !== undefined);
    expect(perfCall).toBeDefined();
    expect(perfCall!.enabled).toBe(true);
    expect(perfCall!.config).toContain('eslint-performance.config.mjs');
  });

  it('tool-dispatch 将 toolConfig.config 透传给 Semgrep 适配器', async () => {
    await loader.loadFromFileSystem();

    const receivedConfigs: Array<Record<string, unknown> | undefined> = [];
    const mockAdapter = {
      meta: {
        id: 'semgrep', name: 'Semgrep', category: 'inspect' as const, priority: 'P0' as const,
        installMode: 'builtin' as const, description: '', cliCommand: 'semgrep', homepage: '', license: '',
      },
      isAvailable: async () => true,
      scan: async (opts: ToolScanOptions) => {
        receivedConfigs.push(opts.config);
        return {
          tool: 'semgrep' as const,
          status: 'available' as const,
          issues: [],
          metadata: { version: '', duration: 10, timestamp: new Date(), fileCount: 0 },
        };
      },
    };

    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'semgrep', adapter: mockAdapter }],
    });

    const report = await engine.evaluateRules({ repoRoot: '/test-project', domain: 'inspect' });
    const evalResult = report.evaluations.find((e) => e.rule.id === 'inspect.scan.official.semgrep-redos');
    expect(evalResult).toBeDefined();
    expect(evalResult!.status).toBe('passed');

    const perfCall = receivedConfigs.find((c) => c?.config !== undefined);
    expect(perfCall).toBeDefined();
    expect(perfCall!.enabled).toBe(true);
    expect(perfCall!.config).toContain('redos.yml');
  });

  it('性能规则 category 信号从 yml 透传到 violation', async () => {
    await loader.loadFromFileSystem();

    // mockAdapter 读 opts.config.category（由 runToolScan 从 toolConfig.category 透传）
    // 并回写到 issue.category，验证 yml → interpreter → runToolScan → adapter → toolScanViolations 全链路
    const mockAdapter = {
      meta: {
        id: 'eslint', name: 'ESLint', category: 'inspect' as const, priority: 'P0' as const,
        installMode: 'builtin' as const, description: '', cliCommand: 'eslint', homepage: '', license: '',
      },
      isAvailable: async () => true,
      scan: async (opts: ToolScanOptions) => ({
        tool: 'eslint' as const,
        status: 'available' as const,
        issues: [{
          id: 'perf-1',
          ruleId: 'runtime-complexity/no-immutable-reduce',
          severity: 'warning',
          category: opts.config?.category ?? 'quality',
          message: 'reduce 内展开累加器导致 O(n²)',
          file: 'src/a.js',
          line: 1,
          column: 1,
          suggestion: undefined,
          autoFixable: false,
          source: 'inspect',
          fingerprint: 'perf-1:src/a.js:1',
        }],
        metadata: { version: '', duration: 10, timestamp: new Date(), fileCount: 1 },
      }),
    };

    const engine = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'eslint', adapter: mockAdapter }],
    });

    const report = await engine.evaluateRules({ repoRoot: '/test-project', domain: 'inspect' });
    const evalResult = report.evaluations.find((e) => e.rule.id === 'inspect.scan.official.eslint-performance');
    expect(evalResult).toBeDefined();
    expect(evalResult!.violations?.length).toBe(1);
    expect(evalResult!.violations?.[0]?.category).toBe('performance');
  });
});
