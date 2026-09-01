// core11.ts — 固定样本模块 10（确定性生成，勿手改）
export interface Item10 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem10(id: number, label: string): Item10 {
  return { id, label, active: id % 2 === 0 };
}

export function describe10(item: Item10): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_10: Item10[] = Array.from({ length: 8 }, (_, i) =>
  makeItem10(i, `item-${i}`),
);
