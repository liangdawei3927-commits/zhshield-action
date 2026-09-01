// coreutil8.ts — 固定样本模块 19（确定性生成，勿手改）
export interface Item19 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem19(id: number, label: string): Item19 {
  return { id, label, active: id % 2 === 0 };
}

export function describe19(item: Item19): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_19: Item19[] = Array.from({ length: 8 }, (_, i) =>
  makeItem19(i, `item-${i}`),
);
