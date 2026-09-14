// uicomponents2.ts — 固定样本模块 45（确定性生成，勿手改）
export interface Item45 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem45(id: number, label: string): Item45 {
  return { id, label, active: id % 2 === 0 };
}

export function describe45(item: Item45): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_45: Item45[] = Array.from(
  { length: 8 },
  (_, i) => makeItem45(i, `item-${i}`)
);
