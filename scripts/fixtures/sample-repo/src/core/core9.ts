// core9.ts — 固定样本模块 8（确定性生成，勿手改）
export interface Item8 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem8(id: number, label: string): Item8 {
  return { id, label, active: id % 2 === 0 };
}

export function describe8(item: Item8): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_8: Item8[] = Array.from({ length: 8 }, (_, i) =>
  makeItem8(i, `item-${i}`),
);
