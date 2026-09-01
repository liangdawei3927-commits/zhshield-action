// ui4.ts — 固定样本模块 39（确定性生成，勿手改）
export interface Item39 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem39(id: number, label: string): Item39 {
  return { id, label, active: id % 2 === 0 };
}

export function describe39(item: Item39): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_39: Item39[] = Array.from({ length: 8 }, (_, i) =>
  makeItem39(i, `item-${i}`),
);
