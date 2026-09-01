// core8.ts — 固定样本模块 7（确定性生成，勿手改）
export interface Item7 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem7(id: number, label: string): Item7 {
  return { id, label, active: id % 2 === 0 };
}

export function describe7(item: Item7): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_7: Item7[] = Array.from({ length: 8 }, (_, i) =>
  makeItem7(i, `item-${i}`),
);
