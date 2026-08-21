import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getLanguage,
  initI18n,
  resolveLanguage,
  setLanguage as setI18nLanguage,
  t as translate,
  type LanguageCode,
} from '@zh/i18n';

const STORAGE_KEY = 'zhshield.language';

export interface I18nContextValue {
  language: LanguageCode;
  setLanguage: (lng: LanguageCode) => Promise<void>;
  t: (key: string, params?: Record<string, unknown>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readSavedLanguage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeSavedLanguage(lng: LanguageCode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // localStorage 不可用（隐私模式等）时仅内存生效
  }
}

function navigatorLanguage(): string | null {
  return typeof navigator !== 'undefined' ? navigator.language : null;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<LanguageCode>(() => {
    const resolved = resolveLanguage(readSavedLanguage(), navigatorLanguage());
    initI18n({ lng: resolved.value });
    return resolved.value;
  });

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    if (readSavedLanguage()) return;
    let cancelled = false;
    window.electronAPI?.getLocale?.().then((systemLocale) => {
      if (cancelled) return;
      const resolved = resolveLanguage(null, systemLocale);
      if (resolved.value !== getLanguage()) {
        void setI18nLanguage(resolved.value);
        setLanguageState(resolved.value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const changeLanguage = useCallback(async (lng: LanguageCode) => {
    writeSavedLanguage(lng);
    await setI18nLanguage(lng);
    window.electronAPI?.setLanguage?.(lng);
    setLanguageState(lng);
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    return {
      language,
      setLanguage: changeLanguage,
      t: (key: string, params?: Record<string, unknown>) => translate(key, params),
    };
  }, [language, changeLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n 必须在 I18nProvider 内使用');
  return ctx;
}

/** 组件内翻译函数（语言切换自动重渲染） */
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}

/** 获取受支持语言列表（用于语言切换器渲染） */
export { SUPPORTED_LANGUAGES } from '@zh/i18n';
