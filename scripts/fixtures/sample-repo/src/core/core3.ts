// core3.ts — 固定样本模块 2（确定性生成，勿手改）
export interface Item2 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem2(id: number, label: string): Item2 {
  return { id, label, active: id % 2 === 0 };
}

export function describe2(item: Item2): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_2: Item2[] = Array.from({ length: 8 }, (_, i) =>
  makeItem2(i, `item-${i}`),
);
