// services8.ts — 固定样本模块 27（确定性生成，勿手改）
export interface Item27 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem27(id: number, label: string): Item27 {
  return { id, label, active: id % 2 === 0 };
}

export function describe27(item: Item27): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_27: Item27[] = Array.from({ length: 8 }, (_, i) =>
  makeItem27(i, `item-${i}`),
);
