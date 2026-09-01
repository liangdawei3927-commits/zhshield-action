// services7.ts — 固定样本模块 26（确定性生成，勿手改）
export interface Item26 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem26(id: number, label: string): Item26 {
  return { id, label, active: id % 2 === 0 };
}

export function describe26(item: Item26): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_26: Item26[] = Array.from({ length: 8 }, (_, i) =>
  makeItem26(i, `item-${i}`),
);
