import { createContext, useContext, useMemo } from 'react';

// ---------------------------------------------------------------------------
// Detail entry context —— 「查看详情」右上角入口的单一判定源。
// 分类页把本页的详情判定（hasDetail）与打开动作（onOpen）注入 Provider，
// PageShell 右上角图标只读本 context，绝不另写一套判断，避免
// 「图标亮着但点进去是空态」。无 Provider（或 available=false）时不渲染。
// ---------------------------------------------------------------------------

export interface DetailEntryContextValue {
  /** 本页是否已有检查结果（决定右上角图标是否渲染） */
  readonly available: boolean;
  /** 打开详情视图（回到本页详情分支，即 setShowHome(false)） */
  readonly onOpen: () => void;
}

export const DetailEntryContext = createContext<DetailEntryContextValue | null>(null);

/**
 * 取「查看详情」入口能力。**可为 null**：页面组件在独立渲染（无 Provider 挂载）
 * 时必须能优雅降级，因此不抛错（对齐 useNavigation 的宽松模式）。
 */
export function useDetailEntry(): DetailEntryContextValue | null {
  return useContext(DetailEntryContext);
}

export function DetailEntryProvider({
  available,
  onOpen,
  children,
}: {
  available: boolean;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  // useMemo 固定引用，避免每次渲染生成新对象触发消费方重渲染（react-hooks 规则）
  const value = useMemo<DetailEntryContextValue>(
    () => ({ available, onOpen }),
    [available, onOpen],
  );
  return <DetailEntryContext.Provider value={value}>{children}</DetailEntryContext.Provider>;
}
