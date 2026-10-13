/**
 * Machine-readable report formatters (SARIF / JSON).
 *
 * 这些格式化器把各引擎的报告（GuardReport / RuleEngineReport /
 * InspectionReport / RefactorReport / PipelineReport）归一为 SARIF 2.1.0
 * 或 JSON，供 CI（GitHub Action 上传 Security 面板、状态检查阻断）消费。
 *
 * 设计要点：
 * - 与 ConsoleReporter 解耦：本模块只产出「机器可读」产物，不参与文本渲染。
 * - 通过结构化类型守卫识别报告种类，避免硬依赖具体运行时类型。
 */
import type { BaselineEntry } from '@zh/shared';
import type { GuardReport } from '@zh/guard';
import type { RuleEngineReport, Violation } from '@zh/kernel';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { PipelineReport } from '@zh/pipeline';

/** 归一化后的发现严重级（三档，供 SARIF level 与 fail-on 阈值比较） */
export type FindingSeverity = 'error' | 'warning' | 'info';

/** 发现来源域（决定 CI 面板归属与告警路由） */
export type FindingSource = 'guard' | 'inspect' | 'refactor' | 'security' | 'sentinel';

/** 阻断阈值：none 表示永不阻断，其余映射到严重级秩 */
export type FailOn = 'error' | 'warning' | 'info' | 'none';

/** FailOn 合法值列表：供 CLI 解析边界校验与帮助文案复用，避免枚举漂移 */
export const FAIL_ON_VALUES = ['error', 'warning', 'info', 'none'] as const;

/** 严格校验 FailOn 枚举值：非空且属于合法值集合，供 CLI 解析边界拦截非法输入 */
export function isFailOnValue(value: string | undefined): value is FailOn {
  return value !== undefined && (FAIL_ON_VALUES as readonly string[]).includes(value);
}

/** 归一化发现条目：各引擎报告收敛后的统一机器可读形态（位置可缺省） */
export interface Finding {
  ruleId: string;
  severity: FindingSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  category?: string;
  source: FindingSource;
  suggestion?: string;
  /**
   * 基线豁免标注：映射为 SARIF 原生 suppressions。
   * kind 固定 external —— 豁免由 .zhshield/baseline.json 在源码之外施加，
   * SARIF 规范中 inSource 表示源码内抑制标记，此处不适用。
   */
  suppression?: { kind: 'external'; justification: string };
}

/** 严重级 → 数值秩（error 最高），用于 fail-on 阈值比较 */
const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 3, warning: 2, info: 1 };

/**
 * 取严重级的数值秩（error 3 / warning 2 / info 1），用于阈值比较。
 * @param s 归一化后的严重级
 * @returns 数值秩
 */
export function severityRank(s: FindingSeverity): number {
  return SEVERITY_RANK[s];
}

/**
 * 取阻断阈值的数值秩；'none'（永不阻断）恒为 0。
 * @param f fail-on 阈值
 * @returns 与 {@link severityRank} 同尺度的数值秩
 */
export function failOnRank(f: FailOn): number {
  return f === 'none' ? 0 : SEVERITY_RANK[f];
}

/** 将内核/适配器产出的任意 severity 字符串归一为 FindingSeverity */
function toFindingSeverity(s: string | undefined): FindingSeverity {
  switch (s) {
    case 'critical':
    case 'high':
    case 'error':
      return 'error';
    case 'medium':
    case 'warning':
      return 'warning';
    case 'low':
    case 'info':
      return 'info';
    default:
      return 'warning';
  }
}

// ─── 类型守卫 ─────────────────────────────────────────

function isGuardReport(r: unknown): r is GuardReport {
  return (
    !!r &&
    typeof r === 'object' &&
    Array.isArray((r as { results?: unknown }).results) &&
    !!(r as { summary?: unknown }).summary
  );
}

function isRuleEngineReport(r: unknown): r is RuleEngineReport {
  return (
    !!r &&
    typeof r === 'object' &&
    Array.isArray((r as { evaluations?: unknown }).evaluations) &&
    typeof (r as { ok?: unknown }).ok === 'boolean'
  );
}

function isInspectionReport(r: unknown): r is InspectionReport {
  return (
    !!r &&
    typeof r === 'object' &&
    Array.isArray((r as { issues?: unknown }).issues) &&
    !!(r as { summary?: unknown }).summary &&
    'score' in (r as object)
  );
}

function isRefactorReport(r: unknown): r is RefactorReport {
  return (
    !!r &&
    typeof r === 'object' &&
    Array.isArray((r as { files?: unknown }).files) &&
    !!(r as { bySeverity?: unknown }).bySeverity
  );
}

function isPipelineReport(r: unknown): r is PipelineReport {
  return (
    !!r &&
    typeof r === 'object' &&
    'stage' in (r as object) &&
    ('guard' in (r as object) || 'inspect' in (r as object) || 'refactor' in (r as object))
  );
}

// ─── 归一化 ───────────────────────────────────────────

function guardFindings(report: GuardReport): Finding[] {
  const findings: Finding[] = [];
  for (const res of report.results) {
    if (res.status === 'passed') continue;
    const details = res.details as { violations?: Violation[] } | undefined;
    if (details?.violations?.length) {
      for (const v of details.violations) {
        findings.push({
          ruleId: v.ruleId ?? res.checkId,
          severity: toFindingSeverity(v.severity),
          message: v.message,
          file: v.file,
          line: v.line,
          column: v.column,
          category: v.category,
          source: 'guard',
          suggestion: v.suggestion,
        });
      }
    } else {
      findings.push({
        ruleId: res.checkId,
        severity: res.severity,
        message: res.message,
        source: 'guard',
      });
    }
  }
  return findings;
}

function ruleEngineFindings(report: RuleEngineReport): Finding[] {
  const findings: Finding[] = [];
  for (const ev of report.evaluations) {
    // P0（复查4）：降级跳过必须可见——"未检测 ≠ 通过"。此前 skipped 被静默略过，
    // CI（SARIF 0 results）完全看不到任何检查没跑。
    if (ev.status === 'skipped') {
      if (ev.degraded === true) {
        const ruleId = ev.rule?.id ?? 'unknown';
        findings.push({
          ruleId,
          severity: 'warning',
          message: `检查被降级跳过（未检测 ≠ 通过）: ${ev.rule?.name ?? ruleId}${ev.message ? ` — ${ev.message}` : ''}`,
          source: ev.targetEngine === 'inspect' ? 'inspect' : 'guard',
        });
      }
      continue;
    }
    if (ev.status === 'passed') continue;
    const source: FindingSource = ev.targetEngine === 'inspect' ? 'inspect' : 'guard';
    const ruleId = ev.rule?.id ?? 'unknown';
    if (ev.violations?.length) {
      for (const v of ev.violations) {
        findings.push({
          ruleId: v.ruleId ?? ruleId,
          severity: toFindingSeverity(v.severity),
          message: v.message,
          file: v.file,
          line: v.line,
          column: v.column,
          category: v.category,
          source,
          suggestion: v.suggestion,
        });
      }
    } else {
      findings.push({
        ruleId,
        severity: 'error',
        message: ev.message ?? `${ev.status}: ${ev.rule?.name ?? ruleId}`,
        source,
      });
    }
  }
  return findings;
}

/**
 * 把基线条目的治理字段拼成 SARIF suppressions.justification 要求的可读字符串。
 * 豁免理由缺失时显式标注"未记录"，避免机器输出里出现一条无据可查的静默豁免。
 */
function baselineJustification(entry: BaselineEntry): string {
  const reason = entry.reason ? entry.reason : '未记录豁免理由（需补齐）';
  const owner = entry.owner ? entry.owner : '未指定责任人';
  const expires = entry.expiresAt ? entry.expiresAt : '永久';
  return `基线豁免：${reason}（责任人: ${owner}，到期: ${expires}）`;
}

function inspectionFindings(report: InspectionReport): Finding[] {
  const findings: Finding[] = [];
  for (const issue of report.issues) {
    findings.push({
      ruleId: issue.ruleId,
      severity: issue.severity,
      message: issue.message,
      file: issue.file,
      line: issue.line,
      column: issue.column,
      category: issue.category,
      source: (issue.source as FindingSource) || 'inspect',
      suggestion: issue.suggestion,
    });
  }
  for (const { issue, entry } of report.suppressedIssues ?? []) {
    findings.push({
      ruleId: entry.ruleId,
      severity: issue.severity,
      message: issue.message,
      file: issue.file,
      line: issue.line,
      column: issue.column,
      category: issue.category,
      source: (issue.source as FindingSource) || 'inspect',
      suggestion: issue.suggestion,
      suppression: { kind: 'external', justification: baselineJustification(entry) },
    });
  }
  // P0（复查4）：降级跳过的检查项必须出现在 findings（SARIF/CI 可见）
  for (const r of report.adapterResults ?? []) {
    if (r.degraded === true) {
      findings.push({
        ruleId: r.adapterId,
        severity: 'warning',
        message: `检查项被降级跳过（未检测 ≠ 通过）: ${r.adapterName}${r.skipDetail ? ` — ${r.skipDetail}` : ''}`,
        source: 'inspect',
      });
    }
  }
  // P1（复查5）：status==='error' 且无 issue 的适配器此前在 SARIF/CI 完全不可见
  // （issues 为空 → 循环产出 0 条）→ 补一条 error finding，并带上真实原因。
  for (const r of report.adapterResults ?? []) {
    const hasIssues = (r.issues?.length ?? 0) > 0 || r.issueCount > 0;
    if (r.status === 'error' && !hasIssues) {
      findings.push({
        ruleId: r.adapterId,
        severity: 'error',
        message: `检查工具执行失败（未产出检测结果）: ${r.adapterName} — ${r.errorDetail ?? '未提供失败原因'}`,
        source: 'inspect',
      });
    }
  }
  return findings;
}

function refactorFindings(report: RefactorReport): Finding[] {
  const findings: Finding[] = [];
  for (const file of report.files) {
    for (const smell of file.smells) {
      findings.push({
        ruleId: smell.ruleId,
        severity: smell.severity,
        message: smell.message,
        file: smell.location.filePath,
        line: smell.location.line,
        column: smell.location.column,
        category: smell.category,
        source: 'refactor',
        suggestion: smell.suggestion?.description,
      });
    }
  }
  return findings;
}

/**
 * 把任意报告对象抽取为统一的 Finding 列表（只包含「未通过」的条目，
 * 即 status !== passed）。passed 的检查不产生 Finding，避免 SARIF 噪声。
 */
export function buildFindings(report: unknown): Finding[] {
  const findings: Finding[] = [];
  if (!report) return findings;

  if (isGuardReport(report)) return guardFindings(report);
  if (isRuleEngineReport(report)) return ruleEngineFindings(report);
  if (isInspectionReport(report)) return inspectionFindings(report);
  if (isRefactorReport(report)) return refactorFindings(report);

  if (isPipelineReport(report)) {
    if (report.guard) findings.push(...buildFindings(report.guard));
    if (report.inspect) findings.push(...buildFindings(report.inspect));
    if (report.refactor) findings.push(...buildFindings(report.refactor));
    return findings;
  }

  return findings;
}

// ─── SARIF 2.1.0 ──────────────────────────────────────

/**
 * 把 Finding 列表渲染为 SARIF 2.1.0 JSON 字符串。
 *
 * level 映射：error→error，warning→warning，info→note（GitHub SARIF 合法值）。
 * GitHub Code Scanning 要求每个 result 至少一个 location（缺失会被整份拒绝：
 * "expected at least one location"），因此无文件的 finding 回退到占位路径 unknown。
 */
export function toSarif(findings: Finding[], toolName = 'zhshield'): string {
  const rules = new Map<string, { id: string; short: string }>();
  const results = findings.map((f) => {
    if (!rules.has(f.ruleId)) {
      rules.set(f.ruleId, { id: f.ruleId, short: f.message.slice(0, 160) });
    }
    const level = f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'note';
    const result: Record<string, unknown> = {
      ruleId: f.ruleId,
      level,
      message: { text: f.message },
    };
    result.locations = [
      {
        physicalLocation: {
          artifactLocation: { uri: f.file ?? 'unknown' },
          region: { startLine: f.line ?? 1, startColumn: f.column ?? 1 },
        },
      },
    ];
    if (f.suppression) {
      result.suppressions = [
        {
          kind: f.suppression.kind,
          status: 'accepted',
          justification: f.suppression.justification,
        },
      ];
    }
    return result;
  });

  const log = {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: toolName,
            informationUri: 'https://github.com/zhishield/zhshield',
            rules: Array.from(rules.values(), (r) => ({
              id: r.id,
              shortDescription: { text: r.short },
            })),
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(log, null, 2);
}

/** 原始报告序列化为 JSON（供 action 输出 report 产物 / 人工排查） */
export function formatReportJson(report: unknown): string {
  return JSON.stringify(report, null, 2);
}
