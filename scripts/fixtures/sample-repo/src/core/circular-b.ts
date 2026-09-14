// circular-b.ts — 已知问题：与 circular-a 构成循环依赖（确定性植入）
import { aValue } from './circular-a';

export const bValue = 2;

export function readA(): number {
  return aValue;
}
