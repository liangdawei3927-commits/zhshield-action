// ui5.ts — 固定样本模块 40（确定性生成，勿手改）
export interface Item40 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem40(id: number, label: string): Item40 {
  return { id, label, active: id % 2 === 0 };
}

export function describe40(item: Item40): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_40: Item40[] = Array.from({ length: 8 }, (_, i) =>
  makeItem40(i, `item-${i}`),
);
