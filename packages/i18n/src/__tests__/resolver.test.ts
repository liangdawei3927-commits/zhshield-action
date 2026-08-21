import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
} from '../resolver';

describe('normalizeLanguage', () => {
  it('识别精确的语言代码', () => {
    expect(normalizeLanguage('zh-Hans')).toBe('zh-Hans');
    expect(normalizeLanguage('zh-Hant')).toBe('zh-Hant');
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('ko')).toBe('ko');
    expect(normalizeLanguage('ja')).toBe('ja');
  });

  it('将 zh 系列归一化到简体/繁体', () => {
    expect(normalizeLanguage('zh')).toBe('zh-Hans');
    expect(normalizeLanguage('zh-CN')).toBe('zh-Hans');
    expect(normalizeLanguage('zh_CN')).toBe('zh-Hans');
    expect(normalizeLanguage('zh-Hans-CN')).toBe('zh-Hans');
    expect(normalizeLanguage('zh-SG')).toBe('zh-Hans');
    expect(normalizeLanguage('zh-TW')).toBe('zh-Hant');
    expect(normalizeLanguage('zh-HK')).toBe('zh-Hant');
    expect(normalizeLanguage('zh-MO')).toBe('zh-Hant');
    expect(normalizeLanguage('zh-Hant-TW')).toBe('zh-Hant');
  });

  it('归一化 ko / ja / en', () => {
    expect(normalizeLanguage('ko-KR')).toBe('ko');
    expect(normalizeLanguage('ja-JP')).toBe('ja');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage('en-GB')).toBe('en');
  });

  it('不支持的返回 null', () => {
    expect(normalizeLanguage('fr-FR')).toBeNull();
    expect(normalizeLanguage('de')).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
    expect(normalizeLanguage(null)).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
  });
});

describe('resolveLanguage', () => {
  it('显式优先于系统', () => {
    const r = resolveLanguage('ko', 'zh-CN');
    expect(r).toEqual({ source: 'explicit', value: 'ko' });
  });

  it('无显式时采用系统语言', () => {
    const r = resolveLanguage(null, 'ja-JP');
    expect(r).toEqual({ source: 'system', value: 'ja' });
  });

  it('均无时回退默认语言', () => {
    const r = resolveLanguage(null, 'fr-FR');
    expect(r).toEqual({ source: 'fallback', value: DEFAULT_LANGUAGE });
  });
});

describe('SUPPORTED_LANGUAGES', () => {
  it('覆盖五种目标语言', () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code).sort();
    expect(codes).toEqual(['en', 'ja', 'ko', 'zh-Hans', 'zh-Hant']);
  });
});
