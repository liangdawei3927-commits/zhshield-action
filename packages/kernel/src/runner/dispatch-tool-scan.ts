import { resolveOwnerId } from '@zh/shared';
import type { Issue, ToolAdapter, ToolConfig, ToolResult, ToolScanOptions } from '@zh/shared';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext, ToolScanOutcome } from '../sop/_meta/rule-context';
import type {
  RuleEvaluation,
  Violation,
  ToolDispatchInstruction,
} from '../sop/_meta/rule-evaluation';
import type { EngineHost } from './evaluator-host';
import { skipEvaluation } from './evaluation-builders';
import {
  toMessage,
  DEFAULT_TOOL_SCAN_TIMEOUT_MS,
  withToolScanHardTimeout,
  targetEngineOf,
} from './dispatch-shared';
import { logToolExecutionAudit } from './tool-audit';
import { evalGuardConclusion } from './dispatch-guard-conclusion';

// ─── 派发评估：tool-dispatch → ToolAdapter ────────────

export async function evalToolDispatch(
  host: EngineHost,
  rule: SopRule,
  instr: ToolDispatchInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  // 《07》O8：调用方注入结论集时，门禁进入纯判定模式 —— 不启动任何工具进程，
  // 只读供应商域（Owner）的既有结论判 pass/fail；缺结论 → skipped（C4）。
  // 未注入结论（存量调用方 / 单测）保持历史工具派发行为。
  if (rule.domain === 'guard' && context.conclusions !== undefined) {
    return evalGuardConclusion(rule, instr, context);
  }
  const resolution = resolveToolAdapter(host, rule, instr);
  if (resolution.kind === 'skipped') return resolution.result;
  const unavailable = await checkAdapterAvailability(host, resolution.adapter, rule, instr);
  if (unavailable) return unavailable;
  return runToolScanWithCache({ host, adapter: resolution.adapter, rule, instr, context });
}

type AdapterResolution =
  { kind: 'adapter'; adapter: ToolAdapter } | { kind: 'skipped'; result: RuleEvaluation };

/** 解析工具适配器：未注册 / 接口不完整 / 画像 scope 裁剪 → 返回 skipped 结果 */
function resolveToolAdapter(
  host: EngineHost,
  rule: SopRule,
  instr: ToolDispatchInstruction,
): AdapterResolution {
  const adapter = host.toolAdapters.get(instr.tool);
  if (!adapter) {
    // R7 / C3：规则归属其它域时，本域**不执行**它，也**不降级**——
    // 降级是「本该由本域跑却没跑成」的语义；一条归 deps 的依赖审计规则在体检域
    // 缺适配器，是**归属让位**，不是故障。标 degraded 会让每轮扫描固定产出一条
    // 假降级，把真实降级淹成背景噪音，还会永久拉低本域覆盖率（R6 口径）。
    // 该规则若真没跑成，由 Owner 域的报告负责留痕（C3：非 Owner 不重扫）。
    const owner = resolveOwnerId(rule.id);
    if (owner && owner !== rule.domain) {
      return {
        kind: 'skipped',
        result: skipEvaluation(
          rule,
          `规则归 ${owner} 域负责（C3 唯一归属），本域不重复评估`,
          targetEngineOf(rule),
        ),
      };
    }
    return {
      kind: 'skipped',
      result: skipEvaluation(
        rule,
        `未注册工具适配器: ${instr.tool}，无法执行 tool-dispatch`,
        targetEngineOf(rule),
        true,
      ),
    };
  }
  if (!isAdapterUsable(adapter)) {
    return {
      kind: 'skipped',
      result: skipEvaluation(
        rule,
        `工具适配器 ${instr.tool} 接口不完整（缺少 isAvailable 或 scan 方法），tool-dispatch 跳过`,
        targetEngineOf(rule),
        true,
      ),
    };
  }
  // M4 工具执行面随画像裁剪：工具不在当前项目画像 scope 内 → 视为既定裁剪跳过（不进可用性/扫描）
  if (host.toolScope && !host.toolScope(instr.tool)) {
    return {
      kind: 'skipped',
      result: skipEvaluation(
        rule,
        `工具 ${instr.tool} 不在当前项目画像 scope 内，tool-dispatch 跳过`,
        targetEngineOf(rule),
      ),
    };
  }
  return { kind: 'adapter', adapter };
}

async function checkAdapterAvailability(
  host: EngineHost,
  adapter: ToolAdapter,
  rule: SopRule,
  instr: ToolDispatchInstruction,
): Promise<RuleEvaluation | null> {
  const available = await adapter.isAvailable();
  if (!available) {
    return skipEvaluation(
      rule,
      `工具不可用: ${instr.tool}（未安装或在 PATH 中未找到）`,
      targetEngineOf(rule),
      true,
    );
  }
  return null;
}

interface RunToolScanWithCacheParams {
  host: EngineHost;
  adapter: ToolAdapter;
  rule: SopRule;
  instr: ToolDispatchInstruction;
  context: RuleContext;
}

/**
 * M1b 工具调用去重：同一次调用内同 (tool, configHash) 的规则共享一次真实扫描（single-flight）。
 * 可用性检查始终前置（不进缓存），保证各消费者得到各自的 skipped 语义。
 */
async function runToolScanWithCache(params: RunToolScanWithCacheParams): Promise<RuleEvaluation> {
  const { host, adapter, rule, instr, context } = params;
  const cache = context.toolScanCache;
  if (!cache) {
    // 无缓存（旧调用路径）→ 保守直扫，行为与去重前一致
    const outcome = await executeToolScan({ host, adapter, instr, context, initiatingRule: rule });
    return consumeToolScan(rule, instr, outcome);
  }

  const key = toolScanCacheKey(instr.tool, instr.toolConfig);
  let inFlight = cache.get(key);
  if (!inFlight) {
    inFlight = executeToolScan({ host, adapter, instr, context, initiatingRule: rule });
    cache.set(key, inFlight);
  }
  const outcome = await inFlight;
  return consumeToolScan(rule, instr, outcome);
}

/**
 * M1b/A12：单次调用内的扫描去重键。批量预取（prefetch-tool-batch）也用同一口径
 * 往缓存里种结果，保证逐条评估时必然命中。
 */
export function toolScanCacheKey(
  tool: string,
  toolConfig: Record<string, unknown> | undefined,
): string {
  return `${tool}|${stableConfigKey(toolConfig)}`;
}

/** 构造与逐条派发完全一致的 ToolScanOptions（批量预取必须复用，否则归属/过滤会分叉） */
export function buildToolScanOptions(
  context: RuleContext,
  toolConfig: Record<string, unknown> | undefined,
): ToolScanOptions {
  const config = { enabled: true, ...(toolConfig ?? {}) } as ToolConfig;
  return {
    projectPath: context.repoRoot,
    projectId: context.repoRoot,
    targetFiles: context.files,
    config,
    timeout: (toolConfig?.timeout as number) ?? undefined,
  };
}

/** 防御性检查：适配器接口不完整（如 guard 旧 Adapter 缺少 isAvailable/scan）时跳过，而非崩溃 */
function isAdapterUsable(adapter: ToolAdapter): boolean {
  return typeof adapter.isAvailable === 'function' && typeof adapter.scan === 'function';
}

/**
 * M1b：规范化 toolConfig 的稳定序列化（顶层键排序），作为去重键的 config 部分。
 * 键与 runToolScan 实际传入的 config（{ enabled: true, ...toolConfig }）严格对应；
 * 嵌套对象未深排序——最坏情况是语义相同的配置各自执行（漏合），绝不误合。
 */
function stableConfigKey(toolConfig: Record<string, unknown> | undefined): string {
  const config: Record<string, unknown> = { enabled: true, ...(toolConfig ?? {}) };
  const keys = Object.keys(config).sort();
  return JSON.stringify(keys.map((k) => [k, config[k]]));
}

interface ExecuteToolScanParams {
  host: EngineHost;
  adapter: ToolAdapter;
  instr: ToolDispatchInstruction;
  context: RuleContext;
  initiatingRule: SopRule;
}

/**
 * M1b：真实执行一次工具扫描（含审计日志与 tool:executed 事件，均仅在真实执行时发生一次，
 * sopRuleId 为发起规则）。返回的 Promise 永不 reject——扫描失败也是一种结果。
 */
async function executeToolScan(params: ExecuteToolScanParams): Promise<ToolScanOutcome> {
  const { host, adapter, instr, context, initiatingRule } = params;
  try {
    const toolConfig = instr.toolConfig ?? {};
    // 硬上限保护：对齐 InspectEngine ToolAdapterExecutor——即便工具未遵守 timeout，
    // 单次扫描也绝不无限挂起体检。超时 reject → 下方 catch → 该规则落 skipped（A7/C4）。
    const result = await withToolScanHardTimeout(
      adapter.scan(buildToolScanOptions(context, toolConfig)),
      host.toolScanTimeoutMs ?? DEFAULT_TOOL_SCAN_TIMEOUT_MS,
      adapter.meta.id,
    );
    await logToolExecutionAudit(host.auditLogger, adapter.meta.id, result, context.repoRoot);
    void host.eventBus?.emit('tool:executed', {
      tool: adapter.meta.id,
      status: result.status,
      duration: result.metadata.duration,
      issueCount: result.issues.length,
      projectId: context.repoRoot,
      sopRuleId: initiatingRule.id,
      timestamp: new Date(),
    });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

/**
 * M1b：将共享扫描 outcome 组装为当前规则的评估结果（纯组装，无副作用）。
 * 每条规则的 violations 以自身 rule.id 标注，与串行逐条执行逐字段等价。
 */
function consumeToolScan(
  rule: SopRule,
  instr: ToolDispatchInstruction,
  outcome: ToolScanOutcome,
): RuleEvaluation {
  if (!outcome.ok) {
    // 《07》A7 / C4：工具执行失败（超时 / 崩溃 / 缺依赖）是「没查成」，不是代码问题。
    // 落 skipped + degraded：不进 issues、不进扣分分母，但 ok 仍为 false（不得静默通过）。
    return skipEvaluation(
      rule,
      `工具 ${instr.tool} 执行失败: ${outcome.error}`,
      targetEngineOf(rule),
      true,
    );
  }
  return buildToolScanResult(rule, instr, outcome.result);
}

/** 组装工具扫描结果：状态映射 + 违规收集 */
function buildToolScanResult(
  rule: SopRule,
  instr: ToolDispatchInstruction,
  result: ToolResult,
): RuleEvaluation {
  const violations = toolScanViolations(result, rule);
  // 工具自报 error（无违规明细）= 工具故障，同上落 skipped + degraded；
  // 真检出问题（issues 非空）才走 failed，该扣的分照扣。
  const toolFailed = result.status === 'error' && result.issues.length === 0;
  const status: RuleEvaluation['status'] = toolFailed
    ? 'skipped'
    : result.status === 'available' && result.issues.length === 0
      ? 'passed'
      : result.status === 'unavailable'
        ? 'skipped'
        : 'failed';

  return {
    rule,
    status,
    violations,
    files: violations.length > 0 ? [...new Set(violations.map((v) => v.file))] : undefined,
    message:
      violations.length > 0
        ? `工具 ${instr.tool} 发现 ${violations.length} 个问题`
        : result.error
          ? `工具 ${instr.tool} 错误: ${result.error}`
          : `工具 ${instr.tool} 检查通过`,
    durationMs: result.metadata.duration,
    targetEngine: targetEngineOf(rule),
    timestamp: new Date(),
    ...(result.status === 'unavailable' || toolFailed ? { degraded: true as const } : {}),
  };
}

function toolScanViolations(result: ToolResult, rule: SopRule): Violation[] {
  return result.issues.map((issue: Issue) => ({
    id: issue.id,
    ruleId: rule.id,
    severity:
      issue.severity === 'error'
        ? ('high' as const)
        : issue.severity === 'warning'
          ? ('medium' as const)
          : ('low' as const),
    file: issue.file,
    line: issue.line,
    column: issue.column,
    message: issue.message,
    suggestion: issue.suggestion,
    category: issue.category,
  }));
}
