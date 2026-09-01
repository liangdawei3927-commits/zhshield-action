// ui1.ts — 固定样本模块 36（确定性生成，勿手改）
export interface Item36 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem36(id: number, label: string): Item36 {
  return { id, label, active: id % 2 === 0 };
}

export function describe36(item: Item36): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_36: Item36[] = Array.from({ length: 8 }, (_, i) =>
  makeItem36(i, `item-${i}`),
);
