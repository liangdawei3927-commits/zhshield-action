import { useEffect, useState } from 'react';

export type ThemeName = 'teal' | 'legacy' | 'dracula';

const STORAGE_KEY = 'zhshield.theme';

const THEMES: readonly ThemeName[] = ['teal', 'legacy', 'dracula'];

/** 读取本地持久化的主题；缺省或非法值一律回退到默认主题 teal */
function readSavedTheme(): ThemeName {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return (THEMES as readonly string[]).includes(saved as string) ? (saved as ThemeName) : 'teal';
  } catch {
    // localStorage 不可用（隐私模式等）时使用默认主题
    return 'teal';
  }
}

/** 三主题状态管理：读写 localStorage，并把当前主题写入 <html data-theme>（CSS 变量驱动，切换即时生效） */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeName>(readSavedTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage 不可用（隐私模式等）时仅内存生效
    }
  }, [theme]);

  return { theme, setTheme };
}
