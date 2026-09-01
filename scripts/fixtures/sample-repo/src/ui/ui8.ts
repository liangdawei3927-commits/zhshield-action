// ui8.ts — 固定样本模块 43（确定性生成，勿手改）
export interface Item43 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem43(id: number, label: string): Item43 {
  return { id, label, active: id % 2 === 0 };
}

export function describe43(item: Item43): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_43: Item43[] = Array.from({ length: 8 }, (_, i) =>
  makeItem43(i, `item-${i}`),
);
