// services2.ts — 固定样本模块 21（确定性生成，勿手改）
export interface Item21 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem21(id: number, label: string): Item21 {
  return { id, label, active: id % 2 === 0 };
}

export function describe21(item: Item21): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_21: Item21[] = Array.from({ length: 8 }, (_, i) =>
  makeItem21(i, `item-${i}`),
);
