// fixture: 与 dup-noise-b 仅共享 import 样板与防御性 catch 惯用法，无真实重复逻辑
// 回归目标：collectCodeBlocks 过滤器必须排除 import 窗口与过短的归一化块
import { alpha, beta } from './module-a';
import {
  gamma,
  delta,
  type Epsilon,
} from './module-b';
import { zeta, eta } from './module-c';

export function buildA(input: string): string | null {
  try {
    const parsed = JSON.parse(input);
    return parsed.name ?? null;
  } catch {
    return null;
  }
}

export function deriveA(count: number): number | null {
  if (count === 0) {
    return 0;
  }
  try {
    return count * 2;
  } catch {
    return null;
  }
}

export function renderA(rows: string[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    out.push(row.trim());
  }
  return out;
}