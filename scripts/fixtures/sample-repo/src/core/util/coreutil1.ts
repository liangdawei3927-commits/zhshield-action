// coreutil1.ts — 固定样本模块 12（确定性生成，勿手改）
export interface Item12 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem12(id: number, label: string): Item12 {
  return { id, label, active: id % 2 === 0 };
}

export function describe12(item: Item12): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_12: Item12[] = Array.from({ length: 8 }, (_, i) =>
  makeItem12(i, `item-${i}`),
);
