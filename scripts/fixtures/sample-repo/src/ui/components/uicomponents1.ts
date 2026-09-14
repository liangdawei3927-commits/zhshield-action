// uicomponents1.ts — 固定样本模块 44（确定性生成，勿手改）
export interface Item44 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem44(id: number, label: string): Item44 {
  return { id, label, active: id % 2 === 0 };
}

export function describe44(item: Item44): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_44: Item44[] = Array.from(
  { length: 8 },
  (_, i) => makeItem44(i, `item-${i}`)
);
