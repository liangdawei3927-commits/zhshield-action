import { useEffect, useState } from 'react';

/** 用户可选的主题模式：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system';

/** 实际应用到 <html data-theme> 的主题（light→teal 青蓝 / dark→dracula 深墨青） */
export type ThemeName = 'teal' | 'dracula';

const STORAGE_KEY = 'zhshield.theme';

const MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** 旧版主题存储值 → 新版模式，兼容历史设置（此前直接存 teal/dracula） */
const LEGACY_MODE_MAP: Record<string, ThemeMode> = {
  teal: 'light',
  dracula: 'dark',
};

/** 读取本地持久化的模式；缺省/非法/旧版值一律映射或回退到默认 */
function readSavedMode(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if ((MODES as readonly string[]).includes(saved as string)) {
      return saved as ThemeMode;
    }
    if (saved !== null && saved in LEGACY_MODE_MAP) {
      return LEGACY_MODE_MAP[saved];
    }
    return 'system';
  } catch {
    // localStorage 不可用（隐私模式等）时使用默认模式
    return 'system';
  }
}

/** system 模式下按系统深浅偏好解析主题 */
function resolveTheme(mode: ThemeMode): ThemeName {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dracula' : 'teal';
  }
  return mode === 'dark' ? 'dracula' : 'teal';
}

/** 模式状态管理：读写 localStorage，把解析后的主题写入 <html data-theme>；
 *  system 模式实时监听系统深浅偏好（CSS 变量驱动，切换即时生效） */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readSavedMode);

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(mode);
    };
    apply();
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // localStorage 不可用（隐私模式等）时仅内存生效
    }
    if (mode !== 'system') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [mode]);

  return { mode, setMode };
}
