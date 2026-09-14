// uicomponents3.ts — 固定样本模块 46（确定性生成，勿手改）
export interface Item46 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem46(id: number, label: string): Item46 {
  return { id, label, active: id % 2 === 0 };
}

export function describe46(item: Item46): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_46: Item46[] = Array.from(
  { length: 8 },
  (_, i) => makeItem46(i, `item-${i}`)
);
