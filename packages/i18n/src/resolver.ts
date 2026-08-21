/**
 * 语言解析：将任意语言标识（BCP 47 / 平台 locale / 环境变量）归一化为受支持的语言代码。
 *
 * 优先级：显式指定（用户偏好 / CLI --lang / ZH_LANG）> 系统语言 > 默认（zh-Hans）。
 */

export type LanguageCode = 'zh-Hans' | 'zh-Hant' | 'en' | 'ko' | 'ja';

/** 默认语言：简体中文（翻译源语言，目录最完整） */
export const DEFAULT_LANGUAGE: LanguageCode = 'zh-Hans';

export interface LanguageInfo {
  code: LanguageCode;
  /** 用本国语言展示的语言名称（用于语言切换器） */
  nativeName: string;
  englishName: string;
  /** 标准化 BCP 47 tag，用于与浏览器 / Electron 系统 locale 匹配 */
  bcp47: string;
}

export const SUPPORTED_LANGUAGES: readonly LanguageInfo[] = [
  { code: 'zh-Hans', nativeName: '简体中文', englishName: 'Simplified Chinese', bcp47: 'zh-CN' },
  { code: 'zh-Hant', nativeName: '繁體中文', englishName: 'Traditional Chinese', bcp47: 'zh-TW' },
  { code: 'en', nativeName: 'English', englishName: 'English', bcp47: 'en' },
  { code: 'ko', nativeName: '한국어', englishName: 'Korean', bcp47: 'ko' },
  { code: 'ja', nativeName: '日本語', englishName: 'Japanese', bcp47: 'ja' },
];

export function isSupportedLanguage(value: string | null | undefined): value is LanguageCode {
  if (!value) return false;
  return SUPPORTED_LANGUAGES.some((l) => l.code.toLowerCase() === value.toLowerCase());
}

/** 将任意系统语言标识（BCP 47 / 环境变量 / 平台 locale）归一化为受支持的语言代码；不支持时返回 null */
export function normalizeLanguage(value: string | null | undefined): LanguageCode | null {
  if (!value) return null;
  const raw = value.replace(/_/g, '-').trim();
  if (isSupportedLanguage(raw)) return raw as LanguageCode;
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) {
    // 简体：zh、zh-CN、zh-Hans、zh-SG、zh-MY；其余（zh-TW / zh-HK / zh-MO / zh-Hant）→ 繁体
    return lower === 'zh' ||
      lower.startsWith('zh-cn') ||
      lower.startsWith('zh-hans') ||
      lower.startsWith('zh-sg') ||
      lower.startsWith('zh-my')
      ? 'zh-Hans'
      : 'zh-Hant';
  }
  if (lower.startsWith('ko')) return 'ko';
  if (lower.startsWith('ja')) return 'ja';
  if (lower.startsWith('en')) return 'en';
  return null;
}

export interface ResolvedLanguage {
  source: 'explicit' | 'system' | 'fallback';
  value: LanguageCode;
}

/** 优先级：显式指定 > 系统语言 > 默认（zh-Hans） */
export function resolveLanguage(explicit?: string | null, system?: string | null): ResolvedLanguage {
  const explicitLang = normalizeLanguage(explicit);
  if (explicitLang) return { source: 'explicit', value: explicitLang };
  const systemLang = normalizeLanguage(system);
  if (systemLang) return { source: 'system', value: systemLang };
  return { source: 'fallback', value: DEFAULT_LANGUAGE };
}

/** 从环境变量（ZH_LANG / LANG / LC_ALL 等）探测语言；无则返回 null */
export function detectLanguageFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ZH_LANG ?? env.LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? null;
}
