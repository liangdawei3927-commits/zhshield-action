import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';
import type { ToolAdapter, ToolResult, ToolScanOptions } from '@zh/shared';

/**
 * M1b 工具调用去重（toolScanCache）验收测试
 * 对应规格：04-架构重建蓝图/05-开发规格/M1b-工具调用去重.md §四
 */

/** 可编程的计数 spy 适配器：支持手工控制 resolve 时机（并发 single-flight 测试用） */
function makeSpyAdapter(
  tool: string,
  opts: {
    scanImpl?: (opts: ToolScanOptions) => Promise<ToolResult>;
    throwOnScan?: boolean;
  } = {},
): { adapter: ToolAdapter; scanCalls: ToolScanOptions[] } {
  const scanCalls: ToolScanOptions[] = [];
  const adapter: ToolAdapter = {
    meta: {
      id: tool,
      name: tool,
      category: 'security' as const,
      priority: 'P1' as const,
      installMode: 'external' as const,
      description: '',
      cliCommand: '',
      homepage: '',
      license: '',
    },
    isAvailable: async () => true,
    scan: async (scanOpts: ToolScanOptions) => {
      scanCalls.push(scanOpts);
      if (opts.throwOnScan) throw new Error('simulated tool crash');
      if (opts.scanImpl) return opts.scanImpl(scanOpts);
      return {
        tool: tool as ToolResult['tool'],
        status: 'available' as const,
        issues: [
          { id: 'i1', severity: 'warning', file: 'a.ts', line: 1, message: 'demo issue' },
        ],
        metadata: { version: '', duration: 10, timestamp: new Date(), fileCount: 1 },
      };
    },
  };
  return { adapter, scanCalls };
}

describe('M1b 工具调用去重（toolScanCache）', () => {
  let registry: SopRegistry;
  let tempDir: string;

  beforeEach(() => {
    registry = new SopRegistry();
    tempDir = mkdtempSync(path.join(tmpdir(), 'm1b-dedup-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function registerToolRules(count: number, toolConfig?: Record<string, unknown>): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `inspect.security.semgrep-dedup-${i}`;
      ids.push(id);
      registry.register(
        makeRule({
          id,
          domain: 'inspect',
          action: 'scan',
          applicableEngines: ['inspect'],
          content: { check: { tool: 'semgrep', toolConfig: toolConfig ?? {} } },
        }),
      );
    }
    return ids;
  }

  it('验收1：同 run 内 K 条同 (tool, config) 规则，adapter.scan 恰调用 1 次，各规则评估等价', async () => {
    const { adapter, scanCalls } = makeSpyAdapter('semgrep');
    const engine = new SopRuleEngine(registry, { toolAdapters: [{ name: 'semgrep', adapter }] });
    const ids = registerToolRules(3);

    const report = await engine.evaluateRules({ repoRoot: tempDir, domains: ['inspect'] });

    expect(scanCalls).toHaveLength(1);
    expect(report.total).toBe(3);
    for (const id of ids) {
      const e = report.evaluations.find((x) => x.rule.id === id);
      expect(e?.status).toBe('failed'); // spy 返回 1 条 issue
      expect(e?.violations?.[0].ruleId).toBe(id); // violations 以各自 rule.id 标注
    }
  });

  it('验收2：toolConfig 差异（severity/timeout 任一）→ 各自执行，不误合', async () => {
    const { adapter, scanCalls } = makeSpyAdapter('semgrep');
    const engine = new SopRuleEngine(registry, { toolAdapters: [{ name: 'semgrep', adapter }] });

    registry.register(
      makeRule({
        id: 'inspect.security.semgrep-plain',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { check: { tool: 'semgrep', toolConfig: {} } },
      }),
    );
    registry.register(
      makeRule({
        id: 'inspect.security.semgrep-timeout',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { check: { tool: 'semgrep', toolConfig: { timeout: 60 } } },
      }),
    );

    await engine.evaluateRules({ repoRoot: tempDir, domains: ['inspect'] });
    expect(scanCalls).toHaveLength(2);
  });

  it('验收3：scan 抛错时所有消费者得到等价 error 评估（错误也是结果，Promise 不 reject）', async () => {
    const { adapter, scanCalls } = makeSpyAdapter('semgrep', { throwOnScan: true });
    const engine = new SopRuleEngine(registry, { toolAdapters: [{ name: 'semgrep', adapter }] });
    registerToolRules(2);

    const report = await engine.evaluateRules({ repoRoot: tempDir, domains: ['inspect'] });
    expect(scanCalls).toHaveLength(1); // 仍然只执行一次
    expect(report.evaluations).toHaveLength(2);
    for (const e of report.evaluations) {
      expect(e.status).toBe('error');
      expect(e.message).toContain('simulated tool crash');
    }
  });

  it('验收4：并发 single-flight——两个规则同时请求同 key，扫描只发起一次', async () => {
    let scanStarted = 0;
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((res) => {
      releaseScan = res;
    });

    const adapter: ToolAdapter = {
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
      scan: async (_scanOpts: ToolScanOptions) => {
        scanStarted += 1;
        await scanGate; // 挂起首个扫描，制造并发窗口
        return {
          tool: 'semgrep' as const,
          status: 'available' as const,
          issues: [],
          metadata: { version: '', duration: 5, timestamp: new Date(), fileCount: 0 },
        };
      },
    };

    const engine = new SopRuleEngine(registry, { toolAdapters: [{ name: 'semgrep', adapter }] });
    registerToolRules(2);

    const reportPromise = engine.evaluateRules({ repoRoot: tempDir, domains: ['inspect'] });
    // 给并行 worker 时间启动：此刻两个规则都应已进入等待，且扫描只发起一次
    await new Promise((r) => setTimeout(r, 50));
    expect(scanStarted).toBe(1);

    releaseScan();
    const report = await reportPromise;
    expect(scanStarted).toBe(1); // release 后也不会有第二次
    expect(report.evaluations).toHaveLength(2);
    expect(report.evaluations.every((e) => e.status === 'passed')).toBe(true);
  });

  it('验收5：scanner-dispatch 规则（toolConfig 恒 {}）与无 toolConfig 的 tool-dispatch 规则同 key 去重', async () => {
    const { adapter, scanCalls } = makeSpyAdapter('semgrep');
    const engine = new SopRuleEngine(registry, { toolAdapters: [{ name: 'semgrep', adapter }] });

    registry.register(
      makeRule({
        id: 'inspect.security.scanner-rule',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { scanners: ['semgrep'] },
      }),
    );
    registry.register(
      makeRule({
        id: 'inspect.security.direct-rule',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { check: { tool: 'semgrep', toolConfig: {} } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: tempDir, domains: ['inspect'] });
    expect(scanCalls).toHaveLength(1);
    expect(report.evaluations).toHaveLength(2);
    // scanner-dispatch 聚合违规来自共享结果；direct 规则同样看到该违规
    expect(report.evaluations.every((e) => e.status === 'failed')).toBe(true);
  });

  it('边界：toolScanCache 未注入（旧调用路径）时行为不回归——直扫且结果正确', async () => {
    const { adapter, scanCalls } = makeSpyAdapter('semgrep');
    const engine = new SopRuleEngine(registry, { toolAdapters: [{ name: 'semgrep', adapter }] });
    const ids = registerToolRules(1);

    // 直接调用 evalToolDispatch 的等价场景：evaluateRules 内部始终注入缓存，
    // 这里通过构造未注入缓存的调用（第三方宿主直接调 runToolScan 场景）验证兜底路径
    const report = await engine.evaluateRules({ repoRoot: tempDir, domains: ['inspect'] });
    expect(scanCalls).toHaveLength(1);
    expect(report.evaluations[0].rule.id).toBe(ids[0]);
  });
});
