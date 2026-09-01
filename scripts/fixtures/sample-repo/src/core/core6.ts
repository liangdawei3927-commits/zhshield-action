// core6.ts — 固定样本模块 5（确定性生成，勿手改）
export interface Item5 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem5(id: number, label: string): Item5 {
  return { id, label, active: id % 2 === 0 };
}

export function describe5(item: Item5): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_5: Item5[] = Array.from({ length: 8 }, (_, i) =>
  makeItem5(i, `item-${i}`),
);
