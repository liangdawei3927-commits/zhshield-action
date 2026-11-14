/**
 * 供应链威胁扫描公共工具（threat-utils.ts）
 *
 * npm-threat-scanner 与 pypi-threat-scanner 原先各自复制了一份 typosquatting
 * 编辑距离计算与威胁条目构造逻辑，去重后统一收敛到此处，两扫描器共享同一实现。
 */
import { randomUUID } from 'crypto';
import type { MalwareItem } from './types';

/** 编辑距离阈值：短包名更宽松（仿冒通常只差一两个字符） */
export function typosquatThreshold(name: string): number {
  return name.length <= 8 ? 1 : 2;
}

/**
 * 两字符串的 Levenshtein 编辑距离。
 *
 * 严格索引访问（noUncheckedIndexedAccess）下的写法要点：
 * - 字符用 `charAt(i)` 取，而不是 `a[i]`：后者在标志开启后是 `string | undefined`，
 *   两个 undefined 相等会被误判成"字符相同"（编辑距离算错，且不报错）。
 * - DP 行的边界值用局部变量承接（`prevDiag` / `prevUp` / `left`），
 *   避免"读数组再判空"的重复样板。
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = new Array<number>(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr: number[] = new Array<number>(n + 1).fill(0);
    curr[0] = i;
    let left = i; // curr[j-1]，随 j 递增滚动
    for (let j = 1; j <= n; j++) {
      const prevUp = prev[j] ?? 0; // 上一行的 curr[j]
      const prevDiag = prev[j - 1] ?? 0; // 上一行的 curr[j-1]
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      const next = Math.min(prevUp + 1, left + 1, prevDiag + cost);
      curr[j] = next;
      left = next;
    }
    prev = curr;
  }
  return prev[n] ?? m;
}

/**
 * 构造「疑似仿冒包」威胁条目。
 *
 * npm 与 PyPI 两个扫描器的仿冒判定分支此前各写一遍同样的 `makeThreatItem(...)` 调用
 * —— 上一轮已把 `levenshtein` / `typosquatThreshold` / `makeThreatItem` 本体收进来，
 * 但**调用点**仍是两份逐字相同的字面量。文案（标题/pattern 前缀/证据句式）是面向用户
 * 的报告内容，两处漂移会让 npm 与 PyPI 的同类发现在报告里长得不一样，故一并收敛。
 *
 * 只收敛这一处：黑名单分支的 title 与 pattern 前缀按生态不同（npm-threat-db /
 * pypi-threat-db），并非逐字相同，强行参数化只会把差异藏进配置表。
 */
export function typosquatThreatItem(
  filePath: string,
  name: string,
  popular: string,
  distance: number,
): MalwareItem {
  return makeThreatItem(filePath, name, {
    severity: 'high',
    title: '疑似仿冒包（typosquatting）',
    pattern: `typosquat:${popular}:${distance}`,
    evidence: `包名 ${name} 与流行包 ${popular} 编辑距离为 ${distance}`,
  });
}

/** 构造供应链威胁条目（type='supply-chain' 的 MalwareItem） */
export function makeThreatItem(
  filePath: string,
  name: string,
  meta: { severity: MalwareItem['severity']; title: string; pattern: string; evidence: string },
): MalwareItem {
  return {
    id: randomUUID(),
    type: 'supply-chain',
    severity: meta.severity,
    title: meta.title,
    description: `检测到供应链威胁：${name}`,
    file: filePath,
    line: 0,
    pattern: meta.pattern,
    evidence: meta.evidence,
  };
}
