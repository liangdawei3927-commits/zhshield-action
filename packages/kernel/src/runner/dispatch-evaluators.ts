import { randomUUID } from 'node:crypto';

import type { Issue, ToolAdapter, ToolConfig, ToolResult, ToolId } from '@zh/shared';
import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type {
  RuleEvaluation,
  Violation,
  CheckListInstruction,
  ScannerDispatchInstruction,
  ToolDispatchInstruction,
  PresetInstruction,
} from '../sop/_meta/rule-evaluation';
import type { EngineHost } from './evaluator-host';

/** 从 unknown 类型的 catch 错误中安全提取 message */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── 派发评估：check-list → GuardEngine ────────────────

export async function evalCheckList(
  host: EngineHost,
  rule: SopRule,
  _instr: CheckListInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  if (!host.guardEngine) {
    return skippedResult(rule, 'GuardEngine 未注册，无法执行 check-list', 'guard');
  }
  if (host.evalDepth > 1) {
    return skippedResult(rule, '跳过 check-list→GuardEngine.run（防止规则引擎重入）', 'guard');
  }
  return runGuardCheck(host.guardEngine, rule, context);
}

async function runGuardCheck(
  guardEngine: NonNullable<EngineHost['guardEngine']>,
  rule: SopRule,
  context: RuleContext,
): Promise<RuleEvaluation> {
  try {
    const result = await guardEngine.run({
      mode: 'guard',
      target: context.repoRoot,
      checks: [rule.id],
      dryRun: context.dryRun ?? false,
    });

    const violations = collectGuardViolations(result, rule);
    return {
      rule,
      status: violations.length === 0 ? 'passed' : 'failed',
      violations,
      message: violations.length > 0
        ? `Guard 检查发现 ${violations.length} 个问题`
        : 'Guard 检查通过',
      durationMs: 0,
      targetEngine: 'guard',
      timestamp: new Date(),
    };
  } catch (err) {
    return errorResult(rule, `Guard 派发失败: ${toMessage(err)}`, 'guard');
  }
}

function collectGuardViolations(
  result: { results?: Array<{ status?: string; message?: string }> } | null | undefined,
  rule: SopRule,
): Violation[] {
  const violations: Violation[] = [];
  if (!result?.results) return violations;

  for (const r of result.results) {
    if (r.status === 'failed' || r.status === 'error') {
      violations.push({
        id: randomUUID(),
        ruleId: rule.id,
        severity: rule.severity,
        file: '',
        message: r.message ?? `Check failed: ${rule.id}`,
      });
    }
  }
  return violations;
}

// ─── 派发评估：scanner-dispatch → 具名工具 / InspectEngine ──────

export async function evalScannerDispatch(
  host: EngineHost,
  rule: SopRule,
  instr: ScannerDispatchInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const viaAdapters = await runScannerAdapters(host, rule, instr, context);
  if (viaAdapters) return viaAdapters;

  if (!host.inspectEngine) {
    return skippedResult(rule, 'InspectEngine 未注册，且无可用扫描器适配器', 'inspect');
  }
  if (host.evalDepth > 1) {
    return skippedResult(rule, '跳过 scanner-dispatch→runScan（防止规则引擎重入）', 'inspect');
  }
  return runInspectScan(host.inspectEngine, rule, context, '巡检');
}

async function runScannerAdapters(
  host: EngineHost,
  rule: SopRule,
  instr: ScannerDispatchInstruction,
  context: RuleContext,
): Promise<RuleEvaluation | null> {
  const scanners = instr.scanners ?? [];
  if (scanners.length === 0) return null;
  const violations: Violation[] = [];
  let anyRan = false;
  for (const tool of scanners) {
    const toolName = String(tool);
    if (!host.toolAdapters.has(toolName)) continue;
    anyRan = true;
    const one = await evalToolDispatch(
      host,
      rule,
      {
        type: 'tool-dispatch',
        tool: toolName,
        toolConfig: {},
        conditions: {},
        judgment: {},
        fix: {},
      },
      context,
    );
    if (one.violations?.length) violations.push(...one.violations);
    if (one.status === 'error' && !one.violations?.length) {
      return { ...one, message: one.message ?? `扫描器 ${toolName} 执行失败` };
    }
  }
  if (!anyRan) return null;

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: violations.length > 0 ? [...new Set(violations.map((v) => v.file))] : undefined,
    message: violations.length > 0
      ? `扫描器发现 ${violations.length} 个问题`
      : '扫描器检查通过',
    durationMs: 0,
    targetEngine: 'inspect',
    timestamp: new Date(),
  };
}

// ─── 派发评估：tool-dispatch → ToolAdapter ────────────

export async function evalToolDispatch(
  host: EngineHost,
  rule: SopRule,
  instr: ToolDispatchInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const adapter = host.toolAdapters.get(instr.tool);
  if (!adapter) {
    return skippedResult(rule, `未注册工具适配器: ${instr.tool}，无法执行 tool-dispatch`, targetEngineOf(rule));
  }

  // 防御性检查：适配器接口不完整（如 guard 旧 Adapter 缺少 isAvailable/scan）时跳过，而非崩溃
  if (typeof adapter.isAvailable !== 'function' || typeof adapter.scan !== 'function') {
    return skippedResult(rule, `工具适配器 ${instr.tool} 接口不完整（缺少 isAvailable 或 scan 方法），tool-dispatch 跳过`, targetEngineOf(rule));
  }

  const available = await adapter.isAvailable();
  if (!available) {
    return skippedResult(rule, `工具不可用: ${instr.tool}（未安装或在 PATH 中未找到）`, targetEngineOf(rule));
  }

  return runToolScan(host, adapter, rule, instr, context);
}

async function runToolScan(
  host: EngineHost,
  adapter: ToolAdapter,
  rule: SopRule,
  instr: ToolDispatchInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  try {
    const toolConfig = instr.toolConfig ?? {};
    const result = await adapter.scan({
      projectPath: context.repoRoot,
      projectId: context.repoRoot,
      targetFiles: context.files,
      config: {
        enabled: true,
        ...toolConfig,
      } as ToolConfig,
      timeout: (toolConfig.timeout as number) ?? undefined,
    });

    await logToolExecutionAudit(host.auditLogger, adapter.meta.id, result, context.repoRoot);

    void host.eventBus?.emit('tool:executed', {
      tool: adapter.meta.id,
      status: result.status,
      duration: result.metadata.duration,
      issueCount: result.issues.length,
      projectId: context.repoRoot,
      sopRuleId: rule.id,
      timestamp: new Date(),
    });

    const violations = toolScanViolations(result, rule);
    const status = result.status === 'available' && result.issues.length === 0 ? 'passed'
      : result.status === 'error' ? 'error'
      : 'failed';

    return {
      rule,
      status,
      violations,
      files: violations.length > 0 ? [...new Set(violations.map((v) => v.file))] : undefined,
      message: violations.length > 0
        ? `工具 ${instr.tool} 发现 ${violations.length} 个问题`
        : result.error ? `工具 ${instr.tool} 错误: ${result.error}`
        : `工具 ${instr.tool} 检查通过`,
      durationMs: result.metadata.duration,
      targetEngine: targetEngineOf(rule),
      timestamp: new Date(),
    };
  } catch (err) {
    return errorResult(rule, `工具 ${instr.tool} 执行失败: ${toMessage(err)}`, targetEngineOf(rule));
  }
}

function toolScanViolations(result: ToolResult, rule: SopRule): Violation[] {
  return result.issues.map((issue: Issue) => ({
    id: issue.id,
    ruleId: rule.id,
    severity: issue.severity === 'error' ? ('high' as const)
      : issue.severity === 'warning' ? ('medium' as const)
      : ('low' as const),
    file: issue.file,
    line: issue.line,
    column: issue.column,
    message: issue.message,
    suggestion: issue.suggestion,
    category: issue.category,
  }));
}

// ─── 派发评估：preset → 优先工具适配器，避免全量 runScan 重入 ──

export async function evalPreset(
  host: EngineHost,
  rule: SopRule,
  instr: PresetInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const tool = pickPresetTool(host, instr);
  if (tool) {
    return evalToolDispatch(
      host,
      rule,
      {
        type: 'tool-dispatch',
        tool,
        toolConfig: {},
        conditions: {},
        judgment: {},
        fix: {},
      },
      context,
    );
  }

  if (!host.inspectEngine) {
    return skippedResult(rule, 'InspectEngine 未注册，且无可用 preset 工具适配器', 'inspect');
  }
  if (host.evalDepth > 1) {
    return skippedResult(rule, '跳过 preset→runScan（防止规则引擎重入）', 'inspect');
  }
  return runInspectScan(host.inspectEngine, rule, context, '预设检查');
}

function pickPresetTool(host: EngineHost, instr: PresetInstruction): string | null {
  const presetHint = (instr.presets ?? []).join(' ').toLowerCase();
  const preferredTools = ['eslint', 'semgrep', 'gitleaks'] as const;
  for (const tool of preferredTools) {
    if (!host.toolAdapters.has(tool)) continue;
    if (tool === 'eslint' || presetHint.includes(tool) || presetHint.includes('error-rules') || presetHint.includes('recommended')) {
      return tool;
    }
  }
  return null;
}

// ─── 共享辅助 ──────────────────────────────────────────

/** 记录 tool-execution 审计（F0-4）。审计为副作用：缺失或写入失败均不得影响扫描结果 */
async function logToolExecutionAudit(
  auditLogger: EngineHost['auditLogger'],
  tool: ToolId,
  result: ToolResult,
  projectId: string,
): Promise<void> {
  if (!auditLogger) return;
  try {
    await auditLogger.logToolExecution({
      tool,
      duration: result.metadata.duration,
      fileCount: result.metadata.fileCount,
      issueCount: result.issues.length,
      status: result.status,
      projectId,
    });
  } catch {
    // 审计日志失败不影响扫描结果
  }
}

async function runInspectScan(
  inspectEngine: NonNullable<EngineHost['inspectEngine']>,
  rule: SopRule,
  context: RuleContext,
  label: string,
): Promise<RuleEvaluation> {
  try {
    const result = await inspectEngine.runScan(context.repoRoot, 'full');
    const total = result?.summary?.total ?? 0;

    return {
      rule,
      status: total === 0 ? 'passed' : 'failed',
      message: `${label}完成: ${total} 个问题`,
      durationMs: 0,
      targetEngine: 'inspect',
      timestamp: new Date(),
    };
  } catch (err) {
    return errorResult(rule, `Inspect 派发失败: ${toMessage(err)}`, 'inspect');
  }
}

function skippedResult(rule: SopRule, message: string, targetEngine: 'guard' | 'inspect'): RuleEvaluation {
  return { rule, status: 'skipped', message, durationMs: 0, targetEngine, timestamp: new Date() };
}

function errorResult(rule: SopRule, message: string, targetEngine: 'guard' | 'inspect'): RuleEvaluation {
  return { rule, status: 'error', message, durationMs: 0, targetEngine, timestamp: new Date() };
}

function targetEngineOf(rule: SopRule): 'guard' | 'inspect' {
  return rule.domain === 'guard' ? 'guard' : 'inspect';
}
