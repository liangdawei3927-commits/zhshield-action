// circular-a.ts — 已知问题：与 circular-b 构成循环依赖（确定性植入）
import { bValue } from './circular-b';

export const aValue = 1;

export function readB(): number {
  return bValue;
}
