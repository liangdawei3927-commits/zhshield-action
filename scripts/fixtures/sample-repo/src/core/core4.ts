// core4.ts — 固定样本模块 3（确定性生成，勿手改）
export interface Item3 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem3(id: number, label: string): Item3 {
  return { id, label, active: id % 2 === 0 };
}

export function describe3(item: Item3): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_3: Item3[] = Array.from({ length: 8 }, (_, i) =>
  makeItem3(i, `item-${i}`),
);
