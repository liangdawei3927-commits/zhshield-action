// core5.ts — 固定样本模块 4（确定性生成，勿手改）
export interface Item4 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem4(id: number, label: string): Item4 {
  return { id, label, active: id % 2 === 0 };
}

export function describe4(item: Item4): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_4: Item4[] = Array.from({ length: 8 }, (_, i) =>
  makeItem4(i, `item-${i}`),
);
