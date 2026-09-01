// services9.ts — 固定样本模块 28（确定性生成，勿手改）
export interface Item28 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem28(id: number, label: string): Item28 {
  return { id, label, active: id % 2 === 0 };
}

export function describe28(item: Item28): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_28: Item28[] = Array.from({ length: 8 }, (_, i) =>
  makeItem28(i, `item-${i}`),
);
