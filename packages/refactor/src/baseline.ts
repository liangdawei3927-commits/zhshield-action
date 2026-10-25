import { relative } from 'node:path';
import type { CodeSmell, FileSmellReport, RefactorReport } from './types';
import { calculateMaintainability, calculatePriority } from './report-math';

/** 重构基线：按文件 → 规则记录坏味道计数，用于增量对比 */
export interface RefactorBaseline {
  version: number;
  generatedAt: string;
  entries: Record<string, Record<string, number>>;
}

/**
 * 基线过滤结果：过滤后的报告 + 被压制的存量计数 + 增量/已修复明细。
 * 调用方用 suppressedCount 提示「基线豁免 N 项」，用 introduced/resolved 展示趋势。
 */
export interface RefactorBaselineFilterResult {
  report: RefactorReport;
  suppressedCount: number;
  introduced: Array<{ file: string; rule: string; current: number; baseline: number }>;
  resolved: Array<{ file: string; rule: string; current: number; baseline: number }>;
}

export function countSmellsByFileAndRule(
  report: RefactorReport,
  projectRoot: string,
): Record<string, Record<string, number>> {
  const entries: Record<string, Record<string, number>> = {};
  for (const fr of report.files) {
    const abs = fr.filePath;
    let rel = relative(projectRoot, abs);
    // normalize to POSIX separators
    rel = rel.replace(/\\/g, '/');
    if (!entries[rel]) {
      entries[rel] = {};
    }
    for (const s of fr.smells) {
      const rid = s.ruleId;
      const map = entries[rel];
      map[rid] = (map[rid] || 0) + 1;
    }
  }
  return entries;
}

export function diffBaseline(
  current: Record<string, Record<string, number>>,
  baseline: Record<string, Record<string, number>>,
): {
  introduced: Array<{ file: string; rule: string; current: number; baseline: number }>;
  resolved: Array<{ file: string; rule: string; current: number; baseline: number }>;
} {
  const introduced: Array<{ file: string; rule: string; current: number; baseline: number }> = [];
  const resolved: Array<{ file: string; rule: string; current: number; baseline: number }> = [];
  const allFiles = new Set<string>([...Object.keys(current), ...Object.keys(baseline)]);
  // Set 没有 sort，展开成数组是必要的（不是「无谓的数组展开」）
  const filesSorted = [...allFiles];
  filesSorted.sort();
  for (const file of filesSorted) {
    const cRules = current[file] || {};
    const bRules = baseline[file] || {};
    const allRules = new Set<string>([...Object.keys(cRules), ...Object.keys(bRules)]);
    const rulesSorted = [...allRules];
    rulesSorted.sort();
    for (const rule of rulesSorted) {
      const c = cRules[rule] ?? 0;
      const b = bRules[rule] ?? 0;
      if (c > b) {
        introduced.push({ file, rule, current: c, baseline: b });
      }
      if (c < b) {
        resolved.push({ file, rule, current: c, baseline: b });
      }
    }
  }
  return { introduced, resolved };
}

/**
 * 棘轮过滤：用基线计数压制存量异味，报告只保留超出基线的增量部分。
 *
 * 语义：对每个 (文件, 规则) 对，基线允许保留 baseline 条；当前超出部分（introduced）
 * 逐条留在报告里，未超出的存量计入 suppressedCount。某文件全部异味都被压制时整个
 * 文件报告移除。文件级评分（maintainabilityScore/refactorPriority）按过滤后的异味
 * 集用与引擎相同的公式重算，避免「页面显示 1 条却标红 critical」的口径漂移。
 *
 * 哪些条目算增量是计数级的（不追踪具体行号），确定性地保留每个 (文件, 规则) 组内
 * 报告顺序的前 (current - baseline) 条之外的存量——即组内前 allowed 条视为存量。
 *
 * @param baselineCounts 基线计数（RefactorBaseline.entries 形状）；空对象等价于不过滤。
 */
export function applyRefactorBaseline(
  report: RefactorReport,
  baselineCounts: Record<string, Record<string, number>>,
  projectRoot: string,
): RefactorBaselineFilterResult {
  const current = countSmellsByFileAndRule(report, projectRoot);
  const { introduced, resolved } = diffBaseline(current, baselineCounts);

  let suppressedCount = 0;
  const files: FileSmellReport[] = [];
  const byCategory: RefactorReport['byCategory'] = {};
  const bySeverity: RefactorReport['bySeverity'] = { error: 0, warning: 0, info: 0 };
  const suggestionsByType: Record<string, number> = {};
  let totalSmells = 0;

  for (const fr of report.files) {
    const rel = relative(projectRoot, fr.filePath).replace(/\\/g, '/');
    const allowedByRule = baselineCounts[rel] ?? {};
    // 组内按报告顺序，前 allowed 条视为存量（与 countSmellsByFileAndRule 的累加顺序一致）
    const usedByRule: Record<string, number> = {};
    const kept: CodeSmell[] = [];
    for (const s of fr.smells) {
      const allowed = allowedByRule[s.ruleId] ?? 0;
      const used = usedByRule[s.ruleId] ?? 0;
      if (used < allowed) {
        usedByRule[s.ruleId] = used + 1;
        suppressedCount++;
        continue;
      }
      kept.push(s);
    }
    if (kept.length === 0) continue;

    totalSmells += kept.length;
    files.push({
      ...fr,
      totalSmells: kept.length,
      smells: kept,
      maintainabilityScore: calculateMaintainability(kept),
      refactorPriority: calculatePriority(kept),
    });
    for (const s of kept) {
      byCategory[s.category] = (byCategory[s.category] || 0) + 1;
      bySeverity[s.severity as keyof typeof bySeverity]++;
      const type = s.suggestion.type;
      suggestionsByType[type] = (suggestionsByType[type] || 0) + 1;
    }
  }

  const criticalFiles = files.filter((f) => f.refactorPriority === 'critical').length;
  const needsImmediateAction = files.filter(
    (f) => f.refactorPriority === 'critical' || f.refactorPriority === 'high',
  ).length;

  const filteredReport: RefactorReport = {
    ...report,
    totalSmells,
    byCategory,
    bySeverity,
    files,
    summary: { criticalFiles, needsImmediateAction, suggestionsByType },
  };
  return { report: filteredReport, suppressedCount, introduced, resolved };
}
