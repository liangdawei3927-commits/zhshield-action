// ui2.ts — 固定样本模块 37（确定性生成，勿手改）
export interface Item37 {
  id: number;
  label: string;
  active: boolean;
}

export function makeItem37(id: number, label: string): Item37 {
  return { id, label, active: id % 2 === 0 };
}

export function describe37(item: Item37): string {
  return `[${item.id}] ${item.label} (${item.active ? 'on' : 'off'})`;
}

export const DEFAULT_ITEMS_37: Item37[] = Array.from({ length: 8 }, (_, i) =>
  makeItem37(i, `item-${i}`),
);
