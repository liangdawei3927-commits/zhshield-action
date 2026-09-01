// core7.ts — 固定样本模块 6（确定性生成，勿手改）
export interface Item6 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem6(id: number, label: string): Item6 {
  return { id, label, active: id % 2 === 0 };
}

export function describe6(item: Item6): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_6: Item6[] = Array.from({ length: 8 }, (_, i) =>
  makeItem6(i, `item-${i}`),
);
