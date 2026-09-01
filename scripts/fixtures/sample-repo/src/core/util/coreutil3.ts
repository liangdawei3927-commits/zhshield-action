// coreutil3.ts — 固定样本模块 14（确定性生成，勿手改）
export interface Item14 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem14(id: number, label: string): Item14 {
  return { id, label, active: id % 2 === 0 };
}

export function describe14(item: Item14): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_14: Item14[] = Array.from({ length: 8 }, (_, i) =>
  makeItem14(i, `item-${i}`),
);
