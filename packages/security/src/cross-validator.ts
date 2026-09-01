import type { Issue } from '@zh/shared';

const CVE_PATTERN = /(CVE-\d{4}-\d+)/i;
const CVE_ALT_PATTERN = /[:/](CVE-\d{4}-\d+)/i;

// ─── 类型 ────────────────────────────────────────────────────

export type CrossConfidence = 'high_confidence' | 'pending_confirmation';

export interface CrossValidationEntry {
  /** CVE ID（如 CVE-2024-1234）或规则 ID */
  cveId: string;
  /** 包名@版本（如 lodash@4.17.20） */
  packageKey: string;
  /** 置信度 */
  confidence: CrossConfidence;
  /** 来源工具列表 */
  sources: string[];
  /** 关联的 Issue（可能来自 trivy、grype 或两者） */
  issues: Issue[];
  /** 综合严重级别 */
  suggestedSeverity: 'error' | 'warning' | 'info';
}

export interface CrossValidationReport {
  /** 高置信度（A ∩ B） */
  highConfidence: CrossValidationEntry[];
  /** Trivy 独有（A - B） */
  trivyOnly: CrossValidationEntry[];
  /** Grype 独有（B - A） */
  grypeOnly: CrossValidationEntry[];
  /** 汇总 */
  summary: {
    total: number;
    highConfidence: number;
    pendingConfirmation: number;
  };
}

// ─── 工具函数 ─────────────────────────────────────────────────

/** 从 Issue 中提取 CVE ID */
function extractCveId(issue: Issue): string | null {
  const id = issue.ruleId || '';
  // 直接匹配 CVE- 开头的
  const cveMatch = id.match(CVE_PATTERN);
  if (cveMatch) return cveMatch[1].toUpperCase();
  // 有些 ruleId 格式是 trivy/CVE-2024-1234 或 grype:CVE-2024-1234
  const altMatch = id.match(CVE_ALT_PATTERN);
  if (altMatch) return altMatch[1].toUpperCase();
  return null;
}

/** 从 message 中提取包@版本信息（如 lodash@4.17.20） */
function extractPkgVersion(issue: Issue): string {
  // message 格式通常为: pkg@version: description
  const msg = issue.message || '';
  const atIdx = msg.indexOf('@');
  if (atIdx === -1) return '';
  const spaceAfter = msg.indexOf(' ', atIdx);
  return spaceAfter === -1 ? msg.substring(0, msg.length) : msg.substring(0, spaceAfter);
}

/** 从 fingerprint 提取包名 */
function extractPkgFromFingerprint(issue: Issue): string {
  const fp = issue.fingerprint || '';
  const parts = fp.split(':');
  // trivy:CVE-2024-1234:target:pkg 或 grype:CVE-2024-1234:pkg
  return parts.at(-1) || '';
}

/** 构建匹配 key：优先 CVE，其次 package@version */
function buildMatchKey(issue: Issue): string {
  const cve = extractCveId(issue);
  if (cve) return cve;
  const pkgVer = extractPkgVersion(issue);
  if (pkgVer) return pkgVer;
  return extractPkgFromFingerprint(issue);
}

// ─── 主逻辑 ──────────────────────────────────────────────────

/**
 * GrypeCrossValidator — 执行 Trivy × Grype 交叉比对
 *
 * A ∩ B → high_confidence（优先处理）
 * A - B → pending_confirmation（标记待确认）
 * B - A → pending_confirmation（标记待确认）
 */
export class GrypeCrossValidator {
  /**
   * 执行交叉验证
   * @param trivyIssues Trivy 输出的 Issue 列表
   * @param grypeIssues Grype 输出的 Issue 列表
   */
  validate(trivyIssues: Issue[], grypeIssues: Issue[]): CrossValidationReport {
    const trivyMap = this.indexByKey(trivyIssues, 'trivy');
    const grypeMap = this.indexByKey(grypeIssues, 'grype');
    const { highConfidence, trivyOnly, grypeOnly } = this.classifyEntries(trivyMap, grypeMap);
    const pending = trivyOnly.length + grypeOnly.length;

    return {
      highConfidence,
      trivyOnly,
      grypeOnly,
      summary: {
        total: highConfidence.length + pending,
        highConfidence: highConfidence.length,
        pendingConfirmation: pending,
      },
    };
  }

  private classifyEntries(
    trivyMap: Map<string, { cveId: string; issues: Issue[] }>,
    grypeMap: Map<string, { cveId: string; issues: Issue[] }>,
  ): {
    highConfidence: CrossValidationEntry[];
    trivyOnly: CrossValidationEntry[];
    grypeOnly: CrossValidationEntry[];
  } {
    const allKeys = new Set([...trivyMap.keys(), ...grypeMap.keys()]);
    const highConfidence: CrossValidationEntry[] = [];
    const trivyOnly: CrossValidationEntry[] = [];
    const grypeOnly: CrossValidationEntry[] = [];

    for (const key of allKeys) {
      const trivyEntry = trivyMap.get(key);
      const grypeEntry = grypeMap.get(key);

      if (trivyEntry && grypeEntry) {
        highConfidence.push(this.buildHighConfidenceEntry(trivyEntry, grypeEntry, key));
        continue;
      }
      if (trivyEntry) {
        trivyOnly.push(this.buildSingleSourceEntry(trivyEntry, 'trivy', key));
        continue;
      }
      if (grypeEntry) {
        grypeOnly.push(this.buildSingleSourceEntry(grypeEntry, 'grype', key));
      }
    }
    return { highConfidence, trivyOnly, grypeOnly };
  }

  private buildHighConfidenceEntry(
    trivyEntry: { cveId: string; issues: Issue[] },
    grypeEntry: { cveId: string; issues: Issue[] },
    key: string,
  ): CrossValidationEntry {
    const allIssues = [...trivyEntry.issues, ...grypeEntry.issues];
    return {
      cveId: trivyEntry.cveId || grypeEntry.cveId || key,
      packageKey: key,
      confidence: 'high_confidence',
      sources: ['trivy', 'grype'],
      issues: allIssues,
      suggestedSeverity: this.maxSeverity(allIssues),
    };
  }

  private buildSingleSourceEntry(
    entry: { cveId: string; issues: Issue[] },
    source: 'trivy' | 'grype',
    key: string,
  ): CrossValidationEntry {
    return {
      cveId: entry.cveId || key,
      packageKey: key,
      confidence: 'pending_confirmation',
      sources: [source],
      issues: entry.issues,
      suggestedSeverity: this.degradeSeverity(entry.issues),
    };
  }

  /** 将 Issue 列表按匹配 key 建立索引 */
  private indexByKey(
    issues: Issue[],
    _source: string,
  ): Map<string, { cveId: string; issues: Issue[] }> {
    const map = new Map<string, { cveId: string; issues: Issue[] }>();

    for (const issue of issues) {
      if (issue.category !== 'security') continue;
      const key = buildMatchKey(issue);
      if (!key) continue;

      const existing = map.get(key);
      if (existing) {
        existing.issues.push(issue);
      } else {
        map.set(key, { cveId: extractCveId(issue) || key, issues: [issue] });
      }
    }

    return map;
  }

  /** 取一组 Issue 中的最大严重级别 */
  private maxSeverity(issues: Issue[]): 'error' | 'warning' | 'info' {
    for (const i of issues) {
      if (i.severity === 'error') return 'error';
    }
    for (const i of issues) {
      if (i.severity === 'warning') return 'warning';
    }
    return 'info';
  }

  /** 降级：pending_confirmation 的 issue 最多 warning（即使工具标了 error） */
  private degradeSeverity(issues: Issue[]): 'error' | 'warning' | 'info' {
    const maxSev = this.maxSeverity(issues);
    // 独有发现最多 warning
    if (maxSev === 'error') return 'warning';
    return maxSev;
  }
}
