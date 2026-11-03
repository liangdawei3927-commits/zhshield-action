/**
 * A12 批量预取：把"规则 → 结果"种进逐条评估共用的缓存槽
 *
 * 为什么单独测这一层：批量本身（`SemgrepAdapter.scanBatch`）只保证"一次进程 + 归属不串"；
 * 「逐条评估会不会真的命中预取结果、键是否与逐条派发同一口径」由本层决定。
 * 键口径一旦分叉，预取就是白跑（每次仍起一次进程），而且不会有任何报错。
 *
 * 锁住四件事：
 *   ① 键与逐条派发一致（`toolScanCacheKey`），结果原样种入；
 *   ② 适配器没实现 scanBatch / 工具不可用 → 不预取（返回 0，缓存不动）；
 *   ③ 预取抛错 → 吞掉并返回 0（逐条派发兜底），绝不影响规则结论；
 *   ④ 少于两条候选 / 带路径 config（无内联 rules）→ 不预取。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ToolAdapter, ToolResult } from '@zh/shared';
import { toolScanCacheKey } from '../runner/dispatch-tool-scan';
import { prefetchToolBatches } from '../runner/prefetch-tool-batch';
import type { ContentInstruction } from '../sop/_meta/rule-evaluation';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { SopRule } from '../sop/_meta/sop-types';
import type { EngineHost } from '../runner/evaluator-host';

/** 用解释器替身：每个 rule 的 content.tool 就是它声明要跑的内联 semgrep 规则 id 列表 */
function dispatchRule(id: string, ruleIds: string[]): SopRule {
  return { id, content: { tool: ruleIds } } as unknown as SopRule;
}

/** 用解释器替身：每个 rule 的 content.tool 就是它声明要跑的内联 semgrep 规则 id 列表 */
function interpret(r: SopRule): ContentInstruction {
  const ruleIds = ((r.content ?? {}) as { tool?: string[] }).tool ?? [];
  return {
    type: 'tool-dispatch',
    tool: 'semgrep',
    toolConfig: { category: 'security', rules: ruleIds.map((rid) => ({ id: rid })) },
    conditions: {},
    judgment: {},
  } as unknown as ContentInstruction;
}

function fakeAdapter(overrides: Partial<ToolAdapter> = {}): ToolAdapter {
  return {
    meta: { id: 'semgrep', name: 'Semgrep', category: 'inspect', priority: 'P0' } as ToolAdapter['meta'],
    isAvailable: async () => true,
    scan: vi.fn(),
    ...overrides,
  } as ToolAdapter;
}

function fakeContext(): RuleContext {
  return { repoRoot: '/repo', files: undefined, toolScanCache: new Map() } as unknown as RuleContext;
}

function fakeHost(adapters: Map<string, ToolAdapter>): EngineHost {
  return {
    toolAdapters: adapters,
    evalDepth: 0,
  } as unknown as EngineHost;
}

function okResult(ruleId: string): ToolResult {
  return {
    tool: 'semgrep',
    status: 'available',
    issues: [
      {
        id: `${ruleId}-issue`,
        ruleId,
        severity: 'error',
        category: 'security',
        message: `hit ${ruleId}`,
        file: 'src/index.ts',
        line: 1,
        column: 1,
      },
    ],
    metadata: { duration: 1, fileCount: 1 },
  } as unknown as ToolResult;
}

describe('prefetchToolBatches — 合并预取并种进缓存', () => {
  it('两条 semgrep 规则合并一次，按逐条派发的同一缓存键种入结果', async () => {
    const scanBatch = vi.fn(async (requests: Array<{ key: string }>) => {
      const map = new Map<string, ToolResult>();
      for (const req of requests) map.set(req.key, okResult(req.key));
      return map;
    });
    const host = fakeHost(new Map([['semgrep', fakeAdapter({ scanBatch })]]));
    const context = fakeContext();
    const rules = [dispatchRule('sec.a', ['a1']), dispatchRule('sec.b', ['b1'])];

    const seeded = await prefetchToolBatches({ host, rules, context, interpret });

    expect(seeded).toBe(2);
    expect(scanBatch).toHaveBeenCalledTimes(1);
    const keyA = toolScanCacheKey('semgrep', { rules: undefined } as never);
    // 缓存键必须是逐条派发会算出来的那个（否则预取白跑）
    for (const r of rules) {
      const expectedKey = toolScanCacheKey(
        'semgrep',
        { category: 'security', rules: ((r.content as { tool: string[] }).tool ?? []).map((id) => ({ id })) },
      );
      expect(context.toolScanCache?.has(expectedKey)).toBe(true);
    }
    expect(context.toolScanCache?.has(keyA)).toBe(false); // 没有多余的槽
  });

  it('适配器没有 scanBatch → 不预取', async () => {
    const host = fakeHost(new Map([['semgrep', fakeAdapter()]]));
    const context = fakeContext();

    const seeded = await prefetchToolBatches({
      host,
      rules: [dispatchRule('sec.a', ['a1']), dispatchRule('sec.b', ['b1'])],
      context,
      interpret,
    });

    expect(seeded).toBe(0);
    expect(context.toolScanCache?.size).toBe(0);
  });

  it('工具不可用 → 不预取（各规则各自拿到 skipped 语义）', async () => {
    const scanBatch = vi.fn();
    const host = fakeHost(
      new Map([['semgrep', fakeAdapter({ scanBatch, isAvailable: async () => false })]]),
    );
    const context = fakeContext();

    const seeded = await prefetchToolBatches({
      host,
      rules: [dispatchRule('sec.a', ['a1']), dispatchRule('sec.b', ['b1'])],
      context,
      interpret,
    });

    expect(seeded).toBe(0);
    expect(scanBatch).not.toHaveBeenCalled();
  });

  it('预取抛错被吞掉：返回 0，绝不影响规则结论', async () => {
    const scanBatch = vi.fn(async () => {
      throw new Error('batch exploded');
    });
    const host = fakeHost(new Map([['semgrep', fakeAdapter({ scanBatch })]]));
    const context = fakeContext();

    const seeded = await prefetchToolBatches({
      host,
      rules: [dispatchRule('sec.a', ['a1']), dispatchRule('sec.b', ['b1'])],
      context,
      interpret,
    });

    expect(seeded).toBe(0);
    expect(context.toolScanCache?.size).toBe(0);
  });

  it('只有内联 rules 的规则参与：带路径 config（无 rules）的规则不预取', async () => {
    const scanBatch = vi.fn(async () => new Map<string, ToolResult>());
    const host = fakeHost(new Map([['semgrep', fakeAdapter({ scanBatch })]]));
    const context = fakeContext();

    const seeded = await prefetchToolBatches({
      host,
      rules: [dispatchRule('sec.a', []), dispatchRule('sec.b', [])],
      context,
      interpret,
    });

    expect(seeded).toBe(0);
    expect(scanBatch).not.toHaveBeenCalled();
  });

  it('工具不在项目画像 scope 内 → 不预取（与逐条派发同一道闸）', async () => {
    const scanBatch = vi.fn(async () => new Map<string, ToolResult>());
    const host = {
      toolAdapters: new Map([['semgrep', fakeAdapter({ scanBatch })]]),
      toolScope: () => false,
      evalDepth: 0,
    } as unknown as EngineHost;
    const context = fakeContext();

    const seeded = await prefetchToolBatches({
      host,
      rules: [dispatchRule('sec.a', ['a1']), dispatchRule('sec.b', ['b1'])],
      context,
      interpret,
    });

    expect(seeded).toBe(0);
    expect(scanBatch).not.toHaveBeenCalled();
  });

  it('少于两条候选 → 不预取（没有收益）', async () => {
    const scanBatch = vi.fn(async () => new Map<string, ToolResult>());
    const host = fakeHost(new Map([['semgrep', fakeAdapter({ scanBatch })]]));
    const context = fakeContext();

    const seeded = await prefetchToolBatches({
      host,
      rules: [dispatchRule('sec.a', ['a1']), dispatchRule('sec.non-tool', [])],
      context,
      interpret,
    });

    expect(seeded).toBe(0);
    expect(scanBatch).not.toHaveBeenCalled();
  });
});
