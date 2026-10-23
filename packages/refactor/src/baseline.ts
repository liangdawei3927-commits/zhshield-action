import { relative } from 'node:path';
import type { RefactorReport } from './types';

/** 重构基线：按文件 → 规则记录坏味道计数，用于增量对比 */
export interface RefactorBaseline {
  version: number;
  generatedAt: string;
  entries: Record<string, Record<string, number>>;
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
  const filesSorted = [...allFiles].sort();
  for (const file of filesSorted) {
    const cRules = current[file] || {};
    const bRules = baseline[file] || {};
    const allRules = new Set<string>([...Object.keys(cRules), ...Object.keys(bRules)]);
    const rulesSorted = [...allRules].sort();
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
