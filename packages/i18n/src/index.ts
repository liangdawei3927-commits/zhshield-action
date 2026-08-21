/**
 * @zh/i18n — 智汇码盾国际化核心包
 *
 * 进程级单例：renderer / Electron main / CLI / server / 引擎各自持有独立实例，
 * 共享同一份五语种目录。
 *
 * 用法：
 *   // 需要切换语言的一端（CLI / Electron main / renderer）
 *   import { initI18n, setLanguage, t } from '@zh/i18n';
 *   initI18n({ lng: resolveLanguage(userPref, app.getLocale()).value });
 *
 *   // 引擎等无状态代码：不依赖全局语言，显式传 locale
 *   import { translate } from '@zh/i18n';
 *   translate('engine.security.vulnUpgrade', locale, { version: '1.2.3' });
 */
import i18next, { type i18n as I18nInstance } from 'i18next';
import { resources } from './resources';
import {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  normalizeLanguage,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
  type LanguageCode,
  type LanguageInfo,
  type ResolvedLanguage,
} from './resolver';

export {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  normalizeLanguage,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
};
export type { LanguageCode, LanguageInfo, ResolvedLanguage };

/** 进程级共享翻译实例（模块加载即初始化，可直接 t()） */
export const i18n: I18nInstance = i18next.createInstance();

export interface InitI18nOptions {
  /** 目标语言；缺省沿用已初始化的语言 */
  lng?: LanguageCode;
  /** 缺失键回退语言；缺省 zh-Hans（源语言目录最完整） */
  fallbackLng?: LanguageCode;
}

/** 初始化（幂等）：首次调用载入资源；重复调用仅切换语言 */
export function initI18n(options: InitI18nOptions = {}): I18nInstance {
  if (!i18n.isInitialized) {
    void i18n.init({
      resources,
      lng: options.lng ?? DEFAULT_LANGUAGE,
      fallbackLng: options.fallbackLng ?? DEFAULT_LANGUAGE,
      interpolation: { escapeValue: false },
      initImmediate: false,
      returnNull: false,
      returnEmptyString: true,
    });
    return i18n;
  }
  if (options.lng && options.lng !== getLanguage()) {
    void i18n.changeLanguage(options.lng);
  }
  return i18n;
}

/** 切换当前语言（异步） */
export function setLanguage(lng: LanguageCode): Promise<void> {
  initI18n({ lng });
  return i18n.changeLanguage(lng).then(() => undefined);
}

/** 当前语言（始终为受支持的语言代码） */
export function getLanguage(): LanguageCode {
  const current = i18n.language ?? i18n.resolvedLanguage ?? DEFAULT_LANGUAGE;
  return isSupportedLanguage(current) ? (current as LanguageCode) : normalizeLanguage(current) ?? DEFAULT_LANGUAGE;
}

/** 当前生效语言（含 fallback 解析结果） */
export function getResolvedLanguage(): LanguageCode {
  const current = i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LANGUAGE;
  return isSupportedLanguage(current) ? (current as LanguageCode) : normalizeLanguage(current) ?? DEFAULT_LANGUAGE;
}

/** 按当前语言翻译（renderer / main / CLI 交互层使用） */
export function t(key: string, params?: Record<string, unknown>): string {
  return i18n.t(key, params ?? {}) as string;
}

/** 无状态翻译：显式指定语言（引擎等纯逻辑代码使用，不依赖全局语言状态） */
export function translate(key: string, lng: LanguageCode, params?: Record<string, unknown>): string {
  return i18n.t(key, { ...(params ?? {}), lng }) as string;
}

// 模块加载即初始化默认语言，保证任意消费者可直接调用 t() / translate()
initI18n();
