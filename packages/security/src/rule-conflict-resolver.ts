import type { Issue, IssueSeverity } from '@zh/shared';

// ─── 类型 ────────────────────────────────────────────────────

/**
 * 单条扫描发现的归一化输入。
 *
 * 位置归一键复用 `Issue.fingerprint`（与 GrypeCrossValidator 同一键空间），
 * 不另造平行类型层级；`source` / `verdict` 是扫描结果本身缺失的元信息，
 * 由调用方（engine 接线层）按工具/规则标注。
 */
export interface RuleFinding {
  /** 产出方标识：工具名或规则 ID（如 'semgrep'、'gitleaks'、'trivy'） */
  source: string;
  /** 分类判定（如 'vulnerability'、'secret'、'injection'）；同一位置判定不一致会进 conflicts */
  verdict: string;
  /** 原始扫描问题；其 `fingerprint` 字段作为位置归一键 */
  issue: Issue;
}

/** 显式豁免（allowlist / ignore-file 命中）：把同指纹发现移出决策集 */
export interface RuleDismissal {
  /** 豁免命中的位置指纹（与 Issue.fingerprint 同一键空间） */
  fingerprint: string;
  /** 豁免来源（allowlist 文件名 / ignore 规则 ID） */
  source: string;
  /** 豁免原因，原样记录进报告 */
  reason: string;
}

/** 确认级别：≥2 个来源相互印证 vs 单一来源无反对 */
export type ConfirmationLevel = 'corroborated' | 'unopposed';

/** 确认 entry：未被豁免、无判定冲突的发现（多来源已去重合并） */
export interface ConfirmedFinding {
  fingerprint: string;
  verdict: string;
  confidence: ConfirmationLevel;
  /** 所有上报方（去重排序） */
  sources: string[];
  issues: Issue[];
  suggestedSeverity: IssueSeverity;
}

/** 误报 entry：被显式豁免的发现，连同豁免依据一起移出决策集 */
export interface FalsePositiveEntry {
  fingerprint: string;
  /** 该位置上的全部判定（去重排序） */
  verdicts: string[];
  dismissedBy: string;
  reason: string;
  issues: Issue[];
}

/** 冲突一方：同一 verdict 下的全部来源与证据 */
export interface ConflictSide {
  verdict: string;
  sources: string[];
  issues: Issue[];
}

/** 冲突 entry：同一位置被给出 ≥2 种互相矛盾的分类，双方都保留、不静默丢弃 */
export interface ConflictEntry {
  fingerprint: string;
  /** 按 verdict 排序的各方 */
  sides: ConflictSide[];
}

/** 无法解析的输入隔离区：缺字段/类型错误的条目不参与决策也不让整体崩溃 */
export interface InvalidEntry {
  /** 在输入数组中的下标 */
  index: number;
  kind: 'finding' | 'dismissal';
  reason: string;
}

export interface RuleConflictReport {
  confirmed: ConfirmedFinding[];
  falsePositives: FalsePositiveEntry[];
  conflicts: ConflictEntry[];
  invalid: InvalidEntry[];
  summary: {
    /** 不同指纹总数 = confirmed + falsePositives + conflicts（invalid 另计） */
    total: number;
    confirmed: number;
    falsePositives: number;
    conflicts: number;
    invalid: number;
  };
}

// ─── 内部工具 ────────────────────────────────────────────────

const SEVERITY_RANK: Record<IssueSeverity, number> = { info: 1, warning: 2, error: 3 };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function maxSeverity(issues: readonly Issue[]): IssueSeverity {
  let max: IssueSeverity = 'info';
  for (const issue of issues) {
    if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[max]) max = issue.severity;
  }
  return max;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** 校验单条 finding；返回稳定的原因字符串或 null（合法） */
function findingError(finding: unknown): string | null {
  if (!isRecord(finding)) return 'finding is not an object';
  if (!isNonEmptyString(finding.source)) return 'finding source missing or empty';
  if (!isNonEmptyString(finding.verdict)) return 'finding verdict missing or empty';
  const issue = finding.issue;
  if (!isRecord(issue)) return 'finding issue missing or not an object';
  if (!isNonEmptyString(issue.fingerprint)) return 'finding issue.fingerprint missing or empty';
  return null;
}

/** 校验单条 dismissal；返回稳定的原因字符串或 null（合法） */
function dismissalError(dismissal: unknown): string | null {
  if (!isRecord(dismissal)) return 'dismissal is not an object';
  if (!isNonEmptyString(dismissal.fingerprint)) return 'dismissal fingerprint missing or empty';
  if (!isNonEmptyString(dismissal.source)) return 'dismissal source missing or empty';
  if (!isNonEmptyString(dismissal.reason)) return 'dismissal reason missing or empty';
  return null;
}

// ─── 主逻辑 ──────────────────────────────────────────────────

/**
 * RuleConflictResolver — F3 二次校验层（通用规则冲突裁决）
 *
 * 纯确定性逻辑（Zero-Token：无 LLM、无 I/O），对多来源扫描结果按
 * `Issue.fingerprint` 归一后做三路分流：
 *
 * - 被显式豁免（allowlist/ignore 命中）→ falsePositives（移出 Guard 决策集）
 * - 同位置出现 ≥2 种矛盾分类 → conflicts（双方保留，不静默丢弃、不计入 confirmed）
 * - 其余 → confirmed（跨工具重复自动去重，sources 合并列出全部上报方）
 * - 缺字段/类型错误的条目 → invalid 隔离区（不崩溃、不污染决策）
 *
 * 报告形态与 `CrossValidationReport` 对齐（lists + summary 计数）。
 */
export class RuleConflictResolver {
  /**
   * 执行二次校验。同一输入永远产出深度相等的报告（确定性）。
   * @param findings 各工具/规则的扫描发现（可混来源，指纹相同即视为同一位置）
   * @param dismissals 显式豁免列表；同一指纹多条豁免时取先出现的一条
   */
  resolve(
    findings: readonly RuleFinding[],
    dismissals: readonly RuleDismissal[] = [],
  ): RuleConflictReport {
    const invalid: InvalidEntry[] = [];
    const byFingerprint = new Map<string, RuleFinding[]>();

    findings.forEach((finding, index) => {
      const error = findingError(finding);
      if (error) {
        invalid.push({ index, kind: 'finding', reason: error });
        return;
      }
      const key = finding.issue.fingerprint;
      const bucket = byFingerprint.get(key);
      if (bucket) {
        bucket.push(finding);
      } else {
        byFingerprint.set(key, [finding]);
      }
    });

    const dismissalByKey = new Map<string, RuleDismissal>();
    dismissals.forEach((dismissal, index) => {
      const error = dismissalError(dismissal);
      if (error) {
        invalid.push({ index, kind: 'dismissal', reason: error });
        return;
      }
      if (!dismissalByKey.has(dismissal.fingerprint)) {
        dismissalByKey.set(dismissal.fingerprint, dismissal);
      }
    });

    const confirmed: ConfirmedFinding[] = [];
    const falsePositives: FalsePositiveEntry[] = [];
    const conflicts: ConflictEntry[] = [];

    const fingerprints = [...byFingerprint.keys()].sort();
    for (const fingerprint of fingerprints) {
      const group = byFingerprint.get(fingerprint) ?? [];
      const dismissal = dismissalByKey.get(fingerprint);

      if (dismissal) {
        falsePositives.push({
          fingerprint,
          verdicts: sortedUnique(group.map((f) => f.verdict)),
          dismissedBy: dismissal.source,
          reason: dismissal.reason,
          issues: group.map((f) => f.issue),
        });
        continue;
      }

      const verdicts = sortedUnique(group.map((f) => f.verdict));
      if (verdicts.length > 1) {
        conflicts.push({
          fingerprint,
          sides: verdicts.map((verdict) => {
            const sideFindings = group.filter((f) => f.verdict === verdict);
            return {
              verdict,
              sources: sortedUnique(sideFindings.map((f) => f.source)),
              issues: sideFindings.map((f) => f.issue),
            };
          }),
        });
        continue;
      }

      const sources = sortedUnique(group.map((f) => f.source));
      confirmed.push({
        fingerprint,
        verdict: verdicts[0] ?? '',
        confidence: sources.length >= 2 ? 'corroborated' : 'unopposed',
        sources,
        issues: group.map((f) => f.issue),
        suggestedSeverity: maxSeverity(group.map((f) => f.issue)),
      });
    }

    return {
      confirmed,
      falsePositives,
      conflicts,
      invalid,
      summary: {
        total: confirmed.length + falsePositives.length + conflicts.length,
        confirmed: confirmed.length,
        falsePositives: falsePositives.length,
        conflicts: conflicts.length,
        invalid: invalid.length,
      },
    };
  }

  /** 组装单条 finding（engine 接线便捷工厂） */
  static finding(source: string, verdict: string, issue: Issue): RuleFinding {
    return { source, verdict, issue };
  }

  /** 把某工具的一组 Issue 打上同一 source/verdict 标注（engine 接线便捷工厂） */
  static fromIssues(source: string, verdict: string, issues: readonly Issue[]): RuleFinding[] {
    return issues.map((issue) => ({ source, verdict, issue }));
  }

  /** 组装单条豁免（engine 接线便捷工厂） */
  static dismissal(fingerprint: string, source: string, reason: string): RuleDismissal {
    return { fingerprint, source, reason };
  }
}
