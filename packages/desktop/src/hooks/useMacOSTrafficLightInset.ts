import { useState, useEffect } from 'react';

/**
 * macOS `titleBarStyle: 'hiddenInset'` 模式下红绿灯按钮占位宽度。
 * 标准 macOS 红绿灯按钮组 ≈ 70px，取 80px 留足间隙。
 */
export const TRAFFIC_LIGHT_OFFSET = 80;

/** 订阅窗口最大化状态变化；非 darwin / 无 API 时立即视为全屏。返回清理函数 */
function subscribeToMaximizedState(setMaximized: (m: boolean) => void): () => void {
  const api = window.electronAPI;
  if (!api || api.platform !== 'darwin') {
    setMaximized(true);
    return () => {};
  }

  let cancelled = false;
  api.isMaximized().then((m) => {
    if (!cancelled) setMaximized(m);
  });

  const cleanup = api.onMaximized((m) => {
    if (!cancelled) setMaximized(m);
  });

  return () => {
    cancelled = true;
    cleanup();
  };
}

/**
 * macOS `titleBarStyle: 'hiddenInset'` 模式下，红绿灯按钮会与左上角内容重叠。
 * 小窗口时需预留左侧间距；全屏 / 非 macOS 平台无需预留。
 *
 * @returns true = 不需要间距（全屏 / 非 macOS / 浏览器开发模式）
 */
export function useMacOSTrafficLightInset(): boolean {
  const [maximized, setMaximized] = useState<boolean | null>(null);

  useEffect(() => subscribeToMaximizedState(setMaximized), [setMaximized]);

  // 尚未确定窗口状态时保守处理（先认为全屏，渲染后快速修正）
  return maximized ?? true;
}
