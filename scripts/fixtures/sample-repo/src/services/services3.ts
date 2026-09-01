// services3.ts — 固定样本模块 22（确定性生成，勿手改）
export interface Item22 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem22(id: number, label: string): Item22 {
  return { id, label, active: id % 2 === 0 };
}

export function describe22(item: Item22): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_22: Item22[] = Array.from({ length: 8 }, (_, i) =>
  makeItem22(i, `item-${i}`),
);
