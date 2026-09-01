// services1.ts — 固定样本模块 20（确定性生成，勿手改）
export interface Item20 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem20(id: number, label: string): Item20 {
  return { id, label, active: id % 2 === 0 };
}

export function describe20(item: Item20): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_20: Item20[] = Array.from({ length: 8 }, (_, i) =>
  makeItem20(i, `item-${i}`),
);
