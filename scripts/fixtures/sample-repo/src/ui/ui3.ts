// ui3.ts — 固定样本模块 38（确定性生成，勿手改）
export interface Item38 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem38(id: number, label: string): Item38 {
  return { id, label, active: id % 2 === 0 };
}

export function describe38(item: Item38): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_38: Item38[] = Array.from({ length: 8 }, (_, i) =>
  makeItem38(i, `item-${i}`),
);
