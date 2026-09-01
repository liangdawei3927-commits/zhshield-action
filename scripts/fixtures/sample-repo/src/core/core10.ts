// core10.ts — 固定样本模块 9（确定性生成，勿手改）
export interface Item9 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem9(id: number, label: string): Item9 {
  return { id, label, active: id % 2 === 0 };
}

export function describe9(item: Item9): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_9: Item9[] = Array.from({ length: 8 }, (_, i) =>
  makeItem9(i, `item-${i}`),
);
