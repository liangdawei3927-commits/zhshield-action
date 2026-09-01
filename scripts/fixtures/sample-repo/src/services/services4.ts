// services4.ts — 固定样本模块 23（确定性生成，勿手改）
export interface Item23 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem23(id: number, label: string): Item23 {
  return { id, label, active: id % 2 === 0 };
}

export function describe23(item: Item23): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_23: Item23[] = Array.from({ length: 8 }, (_, i) =>
  makeItem23(i, `item-${i}`),
);
