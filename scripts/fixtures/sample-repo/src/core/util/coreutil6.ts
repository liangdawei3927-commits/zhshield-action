// coreutil6.ts — 固定样本模块 17（确定性生成，勿手改）
export interface Item17 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem17(id: number, label: string): Item17 {
  return { id, label, active: id % 2 === 0 };
}

export function describe17(item: Item17): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_17: Item17[] = Array.from({ length: 8 }, (_, i) =>
  makeItem17(i, `item-${i}`),
);
