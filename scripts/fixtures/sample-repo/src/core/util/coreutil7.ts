// coreutil7.ts — 固定样本模块 18（确定性生成，勿手改）
export interface Item18 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem18(id: number, label: string): Item18 {
  return { id, label, active: id % 2 === 0 };
}

export function describe18(item: Item18): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_18: Item18[] = Array.from({ length: 8 }, (_, i) =>
  makeItem18(i, `item-${i}`),
);
