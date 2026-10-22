import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type {
  RuleEvaluation,
  Violation,
  ScannerDispatchInstruction,
  PresetInstruction,
} from '../sop/_meta/rule-evaluation';
import type { EngineHost } from './evaluator-host';
import { skipEvaluation } from './evaluation-builders';
import { toMessage, errorResult } from './dispatch-shared';
import { evalToolDispatch } from './dispatch-tool-scan';

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
    return skipEvaluation(rule, 'InspectEngine 未注册，且无可用扫描器适配器', 'inspect', true);
  }
  if (host.evalDepth > 1) {
    return skipEvaluation(rule, '跳过 scanner-dispatch→runScan（防止规则引擎重入）', 'inspect');
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
  const reasons: string[] = [];
  let anyRan = false;
  for (const tool of scanners) {
    const toolName = String(tool);
    // 未注册的扫描器不再静默跳过：计入原因汇总，避免「工具缺失 = 未检测」被误报为通过
    if (!host.toolAdapters.has(toolName)) {
      reasons.push(`${toolName}(未注册工具适配器: ${toolName})`);
      continue;
    }
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
    if (one.status === 'skipped') {
      const msg = one.message ?? '扫描器不可用';
      // 形如「工具不可用: semgrep（未安装或在 PATH 中未找到）」→ 提取括号内原因
      const prefix = `工具不可用: ${toolName}（`;
      const reason =
        msg.startsWith(prefix) && msg.endsWith('）') ? msg.slice(prefix.length, -1) : msg;
      reasons.push(`${toolName}(${reason})`);
      continue;
    }
    anyRan = true;
  }
  // 所有扫描器均未运行（未注册 / 不可用 / 被跳过）→ 显式上报 skipped 并附各工具原因
  if (!anyRan) {
    return skipEvaluation(
      rule,
      reasons.length > 0
        ? `所有扫描器不可用: ${reasons.join(', ')}`
        : '所有扫描器不可用（未配置任何可用扫描器）',
      'inspect',
      true,
    );
  }

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: violations.length > 0 ? [...new Set(violations.map((v) => v.file))] : undefined,
    message: violations.length > 0 ? `扫描器发现 ${violations.length} 个问题` : '扫描器检查通过',
    durationMs: 0,
    targetEngine: 'inspect',
    timestamp: new Date(),
  };
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
    return skipEvaluation(rule, 'InspectEngine 未注册，且无可用 preset 工具适配器', 'inspect', true);
  }
  if (host.evalDepth > 1) {
    return skipEvaluation(rule, '跳过 preset→runScan（防止规则引擎重入）', 'inspect');
  }
  return runInspectScan(host.inspectEngine, rule, context, '预设检查');
}

function pickPresetTool(host: EngineHost, instr: PresetInstruction): string | null {
  const presetHint = (instr.presets ?? []).join(' ').toLowerCase();
  const preferredTools = ['sonarway', 'eslint', 'semgrep', 'gitleaks'] as const;
  for (const tool of preferredTools) {
    if (!host.toolAdapters.has(tool)) continue;
    if (tool === 'sonarway') {
      if (presetHint.includes('sonar')) return tool;
      continue;
    }
    if (
      tool === 'eslint' ||
      presetHint.includes(tool) ||
      presetHint.includes('error-rules') ||
      presetHint.includes('recommended')
    ) {
      return tool;
    }
  }
  return null;
}

async function runInspectScan(
  inspectEngine: NonNullable<EngineHost['inspectEngine']>,
  rule: SopRule,
  context: RuleContext,
  label: string,
): Promise<RuleEvaluation> {
  try {
    // R3d 执行面投影激活：SOP scanner-dispatch 内层直扫透传画像（RuleContext.projectFeature），
    // 无画像 → undefined → 不裁剪（回归安全）。
    const result = await inspectEngine.runScan(context.repoRoot, 'full', context.projectFeature);
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
