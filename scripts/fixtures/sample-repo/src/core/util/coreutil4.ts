// coreutil4.ts — 固定样本模块 15（确定性生成，勿手改）
export interface Item15 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem15(id: number, label: string): Item15 {
  return { id, label, active: id % 2 === 0 };
}

export function describe15(item: Item15): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_15: Item15[] = Array.from({ length: 8 }, (_, i) =>
  makeItem15(i, `item-${i}`),
);
