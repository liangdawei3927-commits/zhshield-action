// services5.ts — 固定样本模块 24（确定性生成，勿手改）
export interface Item24 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem24(id: number, label: string): Item24 {
  return { id, label, active: id % 2 === 0 };
}

export function describe24(item: Item24): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_24: Item24[] = Array.from({ length: 8 }, (_, i) =>
  makeItem24(i, `item-${i}`),
);
