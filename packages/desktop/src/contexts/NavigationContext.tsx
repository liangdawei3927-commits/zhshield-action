import { createContext, useContext } from 'react';

// ---------------------------------------------------------------------------
// Navigation context —— 页面级组件（如 PageShell）不需要逐层透传路由回调，
// 直接从 context 取全局导航。任何页面组件都能用 useNavigation() 跳转。
// ---------------------------------------------------------------------------

export interface NavigationContextValue {
  readonly navigate: (page: string) => void;
  readonly currentPage: string;
}

export const NavigationContext = createContext<NavigationContextValue | null>(null);

/**
 * 取全局导航能力。**可为 null**：页面组件在独立渲染（无 Provider 挂载）
 * 时必须能优雅降级，因此不抛错（区别于 useNotification 的严格模式）。
 */
export function useNavigation(): NavigationContextValue | null {
  return useContext(NavigationContext);
}

export function NavigationProvider({
  navigate,
  currentPage,
  children,
}: {
  navigate: (page: string) => void;
  currentPage: string;
  children: React.ReactNode;
}) {
  return (
    <NavigationContext.Provider value={{ navigate, currentPage }}>
      {children}
    </NavigationContext.Provider>
  );
}