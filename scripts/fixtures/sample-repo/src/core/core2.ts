// core2.ts — 固定样本模块 1（确定性生成，勿手改）
export interface Item1 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem1(id: number, label: string): Item1 {
  return { id, label, active: id % 2 === 0 };
}

export function describe1(item: Item1): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_1: Item1[] = Array.from({ length: 8 }, (_, i) =>
  makeItem1(i, `item-${i}`),
);
