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

/** 两字符串的 Levenshtein 编辑距离 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = new Array<number>(n + 1).fill(0);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[n];
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
