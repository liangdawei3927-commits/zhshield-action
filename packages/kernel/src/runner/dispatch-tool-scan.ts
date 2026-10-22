import type { Issue, ToolAdapter, ToolConfig, ToolResult } from '@zh/shared';

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
  errorResult,
  targetEngineOf,
} from './dispatch-shared';
import { logToolExecutionAudit } from './tool-audit';

// ─── 派发评估：tool-dispatch → ToolAdapter ────────────

export async function evalToolDispatch(
  host: EngineHost,
  rule: SopRule,
  instr: ToolDispatchInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const resolution = resolveToolAdapter(host, rule, instr);
  if (resolution.kind === 'skipped') return resolution.result;
  const unavailable = await checkAdapterAvailability(host, resolution.adapter, rule, instr);
  if (unavailable) return unavailable;
  return runToolScanWithCache({ host, adapter: resolution.adapter, rule, instr, context });
}

type AdapterResolution =
  | { kind: 'adapter'; adapter: ToolAdapter }
  | { kind: 'skipped'; result: RuleEvaluation };

/** 解析工具适配器：未注册 / 接口不完整 / 画像 scope 裁剪 → 返回 skipped 结果 */
function resolveToolAdapter(
  host: EngineHost,
  rule: SopRule,
  instr: ToolDispatchInstruction,
): AdapterResolution {
  const adapter = host.toolAdapters.get(instr.tool);
  if (!adapter) {
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

  const key = `${instr.tool}|${stableConfigKey(instr.toolConfig)}`;
  let inFlight = cache.get(key);
  if (!inFlight) {
    inFlight = executeToolScan({ host, adapter, instr, context, initiatingRule: rule });
    cache.set(key, inFlight);
  }
  const outcome = await inFlight;
  return consumeToolScan(rule, instr, outcome);
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
    // 单次扫描也绝不无限挂起体检。超时 reject → 下方 catch → 该规则降级为 error。
    const result = await withToolScanHardTimeout(
      adapter.scan({
        projectPath: context.repoRoot,
        projectId: context.repoRoot,
        targetFiles: context.files,
        config: {
          enabled: true,
          ...toolConfig,
        } as ToolConfig,
        timeout: (toolConfig.timeout as number) ?? undefined,
      }),
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
    return errorResult(rule, `工具 ${instr.tool} 执行失败: ${outcome.error}`, targetEngineOf(rule));
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
  const status =
    result.status === 'available' && result.issues.length === 0
      ? 'passed'
      : result.status === 'error'
        ? 'error'
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
    ...(result.status === 'unavailable' ? { degraded: true as const } : {}),
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
