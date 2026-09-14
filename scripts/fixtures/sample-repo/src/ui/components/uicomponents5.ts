// uicomponents5.ts — 固定样本模块 48（确定性生成，勿手改）
export interface Item48 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem48(id: number, label: string): Item48 {
  return { id, label, active: id % 2 === 0 };
}

export function describe48(item: Item48): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_48: Item48[] = Array.from(
  { length: 8 },
  (_, i) => makeItem48(i, `item-${i}`)
);
