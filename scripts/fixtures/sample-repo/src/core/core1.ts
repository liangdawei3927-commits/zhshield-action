// core1.ts — 固定样本模块 0（确定性生成，勿手改）
export interface Item0 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem0(id: number, label: string): Item0 {
  return { id, label, active: id % 2 === 0 };
}

export function describe0(item: Item0): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_0: Item0[] = Array.from({ length: 8 }, (_, i) =>
  makeItem0(i, `item-${i}`),
);
