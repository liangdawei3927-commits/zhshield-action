// uicomponents6.ts — 固定样本模块 49（确定性生成，勿手改）
export interface Item49 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem49(id: number, label: string): Item49 {
  return { id, label, active: id % 2 === 0 };
}

export function describe49(item: Item49): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_49: Item49[] = Array.from(
  { length: 8 },
  (_, i) => makeItem49(i, `item-${i}`)
);
