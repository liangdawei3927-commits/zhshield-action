import { randomUUID } from 'node:crypto';

import type { Issue, ToolAdapter, ToolConfig, ToolResult } from '@zh/shared';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
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
  locale?: LanguageCode,
): Promise<RuleEvaluation> {
  if (!host.guardEngine) {
    return skippedResult(rule, translate('engine.kernel.runner.guardEngineNotRegistered', locale ?? DEFAULT_LANGUAGE), 'guard');
  }
  if (host.evalDepth > 1) {
    return skippedResult(rule, translate('engine.kernel.runner.skipCheckListReentry', locale ?? DEFAULT_LANGUAGE), 'guard');
  }
  return runGuardCheck(host.guardEngine, rule, context, locale);
}

async function runGuardCheck(
  guardEngine: NonNullable<EngineHost['guardEngine']>,
  rule: SopRule,
  context: RuleContext,
  locale?: LanguageCode,
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
        ? translate('engine.kernel.runner.guardFoundIssues', locale ?? DEFAULT_LANGUAGE, { count: violations.length })
        : translate('engine.kernel.runner.guardPassed', locale ?? DEFAULT_LANGUAGE),
      durationMs: 0,
      targetEngine: 'guard',
      timestamp: new Date(),
    };
  } catch (err) {
    const message = toMessage(err);
    // check-list 规则指向的检查项在当前仓库的 GuardEngine 配置中不存在时，
    // 属「未配置/不适用」而非执行失败——降级为跳过，避免空配置硬阻断全部提交。
    if (message.includes('no checks matched the current filters')) {
      return skippedResult(rule, translate('engine.kernel.runner.skipCheckListNoMatch', locale ?? DEFAULT_LANGUAGE), 'guard');
    }
    return errorResult(rule, translate('engine.kernel.runner.guardDispatchFailed', locale ?? DEFAULT_LANGUAGE, { error: message }), 'guard');
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
  locale?: LanguageCode,
): Promise<RuleEvaluation> {
  const viaAdapters = await runScannerAdapters(host, rule, instr, context, locale);
  if (viaAdapters) return viaAdapters;

  if (!host.inspectEngine) {
    return skippedResult(rule, translate('engine.kernel.runner.inspectEngineNotRegistered', locale ?? DEFAULT_LANGUAGE), 'inspect');
  }
  if (host.evalDepth > 1) {
    return skippedResult(rule, translate('engine.kernel.runner.skipScannerReentry', locale ?? DEFAULT_LANGUAGE), 'inspect');
  }
  return runInspectScan(host.inspectEngine, rule, context, translate('engine.kernel.runner.labelInspection', locale ?? DEFAULT_LANGUAGE), locale);
}

async function runScannerAdapters(
  host: EngineHost,
  rule: SopRule,
  instr: ScannerDispatchInstruction,
  context: RuleContext,
  locale?: LanguageCode,
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
      locale,
    );
    if (one.violations?.length) violations.push(...one.violations);
    if (one.status === 'error' && !one.violations?.length) {
      return { ...one, message: one.message ?? translate('engine.kernel.runner.scannerFailed', locale ?? DEFAULT_LANGUAGE, { tool: toolName }) };
    }
  }
  if (!anyRan) return null;

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: violations.length > 0 ? [...new Set(violations.map((v) => v.file))] : undefined,
    message: violations.length > 0
      ? translate('engine.kernel.runner.scannerFoundIssues', locale ?? DEFAULT_LANGUAGE, { count: violations.length })
      : translate('engine.kernel.runner.scannerPassed', locale ?? DEFAULT_LANGUAGE),
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
  locale?: LanguageCode,
): Promise<RuleEvaluation> {
  const adapter = host.toolAdapters.get(instr.tool);
  if (!adapter) {
    return skippedResult(
      rule,
      translate('engine.kernel.runner.toolAdapterNotRegistered', locale ?? DEFAULT_LANGUAGE, { tool: instr.tool }),
      targetEngineOf(rule),
    );
  }

  const available = await adapter.isAvailable();
  if (!available) {
    return skippedResult(
      rule,
      translate('engine.kernel.runner.toolUnavailable', locale ?? DEFAULT_LANGUAGE, { tool: instr.tool }),
      targetEngineOf(rule),
    );
  }

  return runToolScan(adapter, rule, instr, context, locale);
}

async function runToolScan(
  adapter: ToolAdapter,
  rule: SopRule,
  instr: ToolDispatchInstruction,
  context: RuleContext,
  locale?: LanguageCode,
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
        ? translate('engine.kernel.runner.toolFoundIssues', locale ?? DEFAULT_LANGUAGE, { tool: instr.tool, count: violations.length })
        : result.error
          ? translate('engine.kernel.runner.toolError', locale ?? DEFAULT_LANGUAGE, { tool: instr.tool, error: result.error })
          : translate('engine.kernel.runner.toolPassed', locale ?? DEFAULT_LANGUAGE, { tool: instr.tool }),
      durationMs: result.metadata.duration,
      targetEngine: targetEngineOf(rule),
      timestamp: new Date(),
    };
  } catch (err) {
    return errorResult(
      rule,
      translate('engine.kernel.runner.toolExecuteFailed', locale ?? DEFAULT_LANGUAGE, { tool: instr.tool, error: toMessage(err) }),
      targetEngineOf(rule),
    );
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
  locale?: LanguageCode,
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
      locale,
    );
  }

  if (!host.inspectEngine) {
    return skippedResult(rule, translate('engine.kernel.runner.presetInspectNotRegistered', locale ?? DEFAULT_LANGUAGE), 'inspect');
  }
  if (host.evalDepth > 1) {
    return skippedResult(rule, translate('engine.kernel.runner.skipPresetReentry', locale ?? DEFAULT_LANGUAGE), 'inspect');
  }
  return runInspectScan(host.inspectEngine, rule, context, translate('engine.kernel.runner.labelPreset', locale ?? DEFAULT_LANGUAGE), locale);
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

async function runInspectScan(
  inspectEngine: NonNullable<EngineHost['inspectEngine']>,
  rule: SopRule,
  context: RuleContext,
  label: string,
  locale?: LanguageCode,
): Promise<RuleEvaluation> {
  try {
    const result = await inspectEngine.runScan(context.repoRoot, 'full');
    const total = result?.summary?.total ?? 0;

    return {
      rule,
      status: total === 0 ? 'passed' : 'failed',
      message: translate('engine.kernel.runner.labelDone', locale ?? DEFAULT_LANGUAGE, { label, count: total }),
      durationMs: 0,
      targetEngine: 'inspect',
      timestamp: new Date(),
    };
  } catch (err) {
    return errorResult(rule, translate('engine.kernel.runner.inspectDispatchFailed', locale ?? DEFAULT_LANGUAGE, { error: toMessage(err) }), 'inspect');
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
