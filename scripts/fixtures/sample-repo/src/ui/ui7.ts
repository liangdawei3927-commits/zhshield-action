// ui7.ts — 固定样本模块 42（确定性生成，勿手改）
export interface Item42 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem42(id: number, label: string): Item42 {
  return { id, label, active: id % 2 === 0 };
}

export function describe42(item: Item42): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_42: Item42[] = Array.from({ length: 8 }, (_, i) =>
  makeItem42(i, `item-${i}`),
);
