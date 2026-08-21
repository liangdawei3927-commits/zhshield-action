/**
 * 五语种翻译目录加载。zh-Hans 为源语言（最完整），其余语言缺失键回退到 zh-Hans。
 */
import type { Resource, ResourceLanguage } from 'i18next';
import zhHans from '../locales/zh-Hans.json';
import zhHant from '../locales/zh-Hant.json';
import en from '../locales/en.json';
import ko from '../locales/ko.json';
import ja from '../locales/ja.json';

export const resources: Resource = {
  'zh-Hans': { translation: zhHans as unknown as ResourceLanguage },
  'zh-Hant': { translation: zhHant as unknown as ResourceLanguage },
  en: { translation: en as unknown as ResourceLanguage },
  ko: { translation: ko as unknown as ResourceLanguage },
  ja: { translation: ja as unknown as ResourceLanguage },
};
