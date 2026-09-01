// core12.ts — 固定样本模块 11（确定性生成，勿手改）
export interface Item11 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem11(id: number, label: string): Item11 {
  return { id, label, active: id % 2 === 0 };
}

export function describe11(item: Item11): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_11: Item11[] = Array.from({ length: 8 }, (_, i) =>
  makeItem11(i, `item-${i}`),
);
