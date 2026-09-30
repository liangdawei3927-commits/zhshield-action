// fixture: 与 dup-noise-a 仅共享 import 样板与防御性 catch 惯用法，实现逻辑完全不同
// 回归目标：collectCodeBlocks 过滤器必须排除 import 窗口与过短的归一化块
import { alpha, beta } from './module-a';
import {
  gamma,
  delta,
  type Epsilon,
} from './module-b';
import { zeta, eta } from './module-c';

export function buildB(input: unknown): string | null {
  const label = String(input);
  try {
    const size = label.length;
    return size > 4 ? label.slice(0, 4) : label;
  } catch {
    return null;
  }
}

export function deriveB(flag: boolean): number {
  if (flag) {
    return 1;
  }
  try {
    return -1;
  } catch {
    return null;
  }
}

export function renderB(items: number[]): number[] {
  const out: number[] = [];
  for (const item of items) {
    out.push(item * 3);
  }
  return out;
}