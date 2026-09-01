// coreutil2.ts — 固定样本模块 13（确定性生成，勿手改）
export interface Item13 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem13(id: number, label: string): Item13 {
  return { id, label, active: id % 2 === 0 };
}

export function describe13(item: Item13): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_13: Item13[] = Array.from({ length: 8 }, (_, i) =>
  makeItem13(i, `item-${i}`),
);
