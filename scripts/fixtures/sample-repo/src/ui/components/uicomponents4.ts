// uicomponents4.ts — 固定样本模块 47（确定性生成，勿手改）
export interface Item47 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem47(id: number, label: string): Item47 {
  return { id, label, active: id % 2 === 0 };
}

export function describe47(item: Item47): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_47: Item47[] = Array.from(
  { length: 8 },
  (_, i) => makeItem47(i, `item-${i}`)
);
