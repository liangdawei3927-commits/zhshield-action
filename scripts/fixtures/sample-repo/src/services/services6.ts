// services6.ts — 固定样本模块 25（确定性生成，勿手改）
export interface Item25 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem25(id: number, label: string): Item25 {
  return { id, label, active: id % 2 === 0 };
}

export function describe25(item: Item25): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_25: Item25[] = Array.from({ length: 8 }, (_, i) =>
  makeItem25(i, `item-${i}`),
);
