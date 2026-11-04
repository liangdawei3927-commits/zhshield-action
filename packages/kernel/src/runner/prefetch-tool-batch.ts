/**
 * A12 最后一刀：同工具、同目标的规则**合并成一次进程**（当前仅 semgrep）。
 *
 * 背景（2026-11-03 进程级实测，`scripts/lib/tool-spy.cjs`）：一轮 `pipeline --full`
 * 的安全域里 `semgrep scan` 出现 **11 次**，argv 各不相同 —— 每条 SOP 规则各写一份
 * 临时 `--config`。运行作用域去重（`tool-run-scope.ts`）只认"完全同参"，看不见这 11 次；
 * 而它们的启动/规则解析开销占了大头（`inspect --sop` 3 分 41 秒的主要来源）。
 *
 * 做法（不动逐条评估的任何逻辑）：
 *   1. `evaluateAll` 开跑前，把"将要派发 semgrep、且带内联 rules"的规则收集起来；
 *   2. 调适配器的 `scanBatch`（可选能力）**跑一次**，拿回 key → ToolResult；
 *   3. 按逐条派发时同一个缓存键（`toolScanCacheKey`）把结果种进 `context.toolScanCache`；
 *   4. 随后每条规则照常走 `runToolScanWithCache` → 直接命中缓存 → 只消费自己那份结果。
 *
 * 正确性边界（每条都是"宁可少合并，不可错合并"）：
 *   · 适配器没实现 `scanBatch` / 工具不可用 / 任一步抛错 → 直接返回，逐条派发照旧；
 *   · 单条规则本来就会被单飞缓存命中（同 toolConfig）→ 不重复预取；
 *   · 预取结果与逐条结果同形状（ToolResult），下游 `consumeToolScan` 不做任何区分；
 *   · 合并失败绝不落成"干净"：整体失败由适配器分发给所有 key，此处不再二次解释。
 */
import type { ToolResult } from '@zh/shared';
import type { ContentInstruction, ToolDispatchInstruction } from '../sop/_meta/rule-evaluation';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { SopRule } from '../sop/_meta/sop-types';
import type { EngineHost } from './evaluator-host';
import { buildToolScanOptions, toolScanCacheKey } from './dispatch-tool-scan';
import { DEFAULT_TOOL_SCAN_TIMEOUT_MS, withToolScanHardTimeout } from './dispatch-shared';

/** 只对"每条规则一次进程"的工具做批量；其余工具要么本来就一次，要么语义不适合合并 */
const BATCHABLE_TOOLS: readonly string[] = ['semgrep'];

/**
 * 逃生开关：`ZH_TOOL_BATCH=off` 关闭合并预取（退回逐条派发）。
 * 用途：出一致性怀疑时一秒判定"是不是合并引起的"，以及做 A/B 归属对照。
 */
const BATCH_DISABLED = process.env.ZH_TOOL_BATCH === 'off';

interface BatchCandidate {
  rule: SopRule;
  instr: ToolDispatchInstruction;
  /** 与逐条派发一致的缓存键 */
  cacheKey: string;
}

/**
 * 预取可合并的工具扫描。永不抛错：任何异常都只是"这次没合并"，逐条派发兜底。
 * 返回真正合并执行的请求数（0 = 未合并）。
 */
export async function prefetchToolBatches(params: {
  host: EngineHost;
  rules: readonly SopRule[];
  context: RuleContext;
  interpret: (rule: SopRule) => ContentInstruction;
}): Promise<number> {
  const { host, rules, context, interpret } = params;
  const cache = context.toolScanCache;
  if (BATCH_DISABLED || !cache || rules.length < 2) return 0;

  const candidates = collectCandidates(rules, interpret, cache);
  if (candidates.length < 2) return 0;

  // candidates.length >= 2 已保证非空，但严格索引访问下首元素仍可能 undefined
  const first = candidates[0];
  if (first === undefined) return 0;
  const toolId = first.instr.tool;

  const adapter = host.toolAdapters.get(toolId);
  if (!adapter || typeof adapter.scanBatch !== 'function') return 0;
  // 与逐条派发同一道 scope 闸：不在项目画像 scope 内的工具，预取也不许起进程
  // （否则批量预取会把"本来会跳过"的扫描变成真实进程开销）
  if (host.toolScope && !host.toolScope(toolId)) return 0;

  try {
    if (!(await adapter.isAvailable())) return 0;
    const results = await withToolScanHardTimeout(
      adapter.scanBatch(
        candidates.map((c) => ({
          key: c.rule.id,
          options: buildToolScanOptions(context, c.instr.toolConfig),
        })),
      ),
      host.toolScanTimeoutMs ?? DEFAULT_TOOL_SCAN_TIMEOUT_MS,
      adapter.meta.id,
    );
    return seedCache(cache, candidates, results);
  } catch {
    // 预取是纯优化：失败即退回逐条派发，不影响任何规则结论
    return 0;
  }
}

/** 把合并结果种进逐条评估共用的缓存槽（ToolScanOutcome 永不 reject） */
function seedCache(
  cache: NonNullable<RuleContext['toolScanCache']>,
  candidates: BatchCandidate[],
  results: Map<string, ToolResult>,
): number {
  let seeded = 0;
  for (const candidate of candidates) {
    const result = results.get(candidate.rule.id);
    if (!result) continue;
    cache.set(candidate.cacheKey, Promise.resolve({ ok: true, result }));
    seeded += 1;
  }
  return seeded;
}

/** 收集候选：同一工具、tool-dispatch、带内联 rules、且尚未在缓存里 */
function collectCandidates(
  rules: readonly SopRule[],
  interpret: (rule: SopRule) => ContentInstruction,
  cache: Map<string, Promise<unknown>>,
): BatchCandidate[] {
  const found: BatchCandidate[] = [];
  for (const rule of rules) {
    const instruction = interpret(rule);
    if (instruction?.type !== 'tool-dispatch') continue;
    const instr = instruction as ToolDispatchInstruction;
    if (!BATCHABLE_TOOLS.includes(instr.tool)) continue;
    const inline = instr.toolConfig?.rules;
    if (!Array.isArray(inline) || inline.length === 0) continue;
    const cacheKey = toolScanCacheKey(instr.tool, instr.toolConfig);
    if (cache.has(cacheKey)) continue;
    found.push({ rule, instr, cacheKey });
  }
  // 只有同一工具的规则才能进同一次合并（防御性保留：BATCHABLE_TOOLS 目前只有 semgrep）
  const tool = found[0]?.instr.tool;
  return found.filter((c) => c.instr.tool === tool);
}
