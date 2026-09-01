// coreutil5.ts — 固定样本模块 16（确定性生成，勿手改）
export interface Item16 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem16(id: number, label: string): Item16 {
  return { id, label, active: id % 2 === 0 };
}

export function describe16(item: Item16): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_16: Item16[] = Array.from({ length: 8 }, (_, i) =>
  makeItem16(i, `item-${i}`),
);
