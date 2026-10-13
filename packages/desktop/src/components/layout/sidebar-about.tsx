import { useState } from 'react';
import { SectionTitle } from './sidebar-common';
import { BounceCard } from '../ui/Bounce';
import { MiniSectionIcon } from '../ui/Icons';
import { useT, useI18n, SUPPORTED_LANGUAGES } from '../../i18n';
import { useTheme, type ThemeMode } from '../../hooks/useTheme';
import type { LanguageCode } from '@zh/i18n';

const THEME_OPTIONS: { value: ThemeMode; labelKey: string; icon: string }[] = [
  { value: 'light', labelKey: 'layout.themeLight', icon: '☀️' },
  { value: 'dark', labelKey: 'layout.themeDark', icon: '🌙' },
  { value: 'system', labelKey: 'layout.themeSystem', icon: '💻' },
];

/** 系统默认语言顺序：英文 → 简体 → 繁体 → 韩文 → 日文；渲染时当前选中语言置顶 */
const LANGUAGE_DEFAULT_ORDER: readonly LanguageCode[] = ['en', 'zh-Hans', 'zh-Hant', 'ko', 'ja'];

export function ThemeSection() {
  const t = useT();
  const { mode, setMode } = useTheme();
  return (
    <section>
      <SectionTitle
        label={t('layout.theme')}
        icon={
          <MiniSectionIcon>
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </MiniSectionIcon>
        }
      />
      <BounceCard className="rounded-xl bg-zh-panel/60 p-3 space-y-1.5">
        {THEME_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer hover:bg-zh-panel transition-colors"
          >
            <span className="text-sm">{option.icon}</span>
            <span className="text-xs text-zh-ink-2 flex-1">{t(option.labelKey)}</span>
            <div className="w-4 h-4 rounded-full border-2 border-zh-line flex items-center justify-center">
              {mode === option.value && (
                <div className="w-2 h-2 rounded-full bg-[rgb(var(--zh-brand))]" />
              )}
            </div>
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={mode === option.value}
              onChange={() => setMode(option.value)}
              className="sr-only"
            />
          </label>
        ))}
      </BounceCard>
    </section>
  );
}

export function LanguageSection() {
  const t = useT();
  const { language, setLanguage } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const ordered = [
    language,
    ...LANGUAGE_DEFAULT_ORDER.filter((code) => code !== language),
  ];
  const visible = expanded ? ordered : ordered.slice(0, 1);

  return (
    <section>
      <SectionTitle
        label={t('layout.language')}
        icon={
          <MiniSectionIcon>
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
          </MiniSectionIcon>
        }
      />
      <BounceCard className="rounded-xl bg-zh-panel/60 p-3 space-y-1.5">
        {visible.map((code) => {
          const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code);
          if (!lang) return null;
          return (
            <button
              key={code}
              type="button"
              onClick={() => {
                if (!expanded) {
                  setExpanded(true);
                  return;
                }
                if (code !== language) void setLanguage(code);
                setExpanded(false);
              }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer hover:bg-zh-panel transition-colors border-none bg-transparent text-left"
            >
              <span className="text-xs text-zh-ink-2 flex-1">{lang.nativeName}</span>
              <div className="w-4 h-4 rounded-full border-2 border-zh-line flex items-center justify-center">
                {language === code && <div className="w-2 h-2 rounded-full bg-success-700" />}
              </div>
            </button>
          );
        })}
        {!expanded && SUPPORTED_LANGUAGES.length > 1 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer hover:bg-zh-panel transition-colors border-none bg-transparent text-left"
          >
            <span className="text-xs text-zh-muted flex-1">
              {t('layout.languageExpand', { count: SUPPORTED_LANGUAGES.length })}
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        )}
      </BounceCard>
    </section>
  );
}

export function AboutSection() {
  const t = useT();
  return (
    <section>
      <SectionTitle
        label={t('layout.about')}
        icon={
          <MiniSectionIcon>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </MiniSectionIcon>
        }
      />
      <div className="px-3 py-2">
        <div className="text-xs text-zh-muted">
          {t('layout.aboutVersion', { version: 'v0.1.0' })}
        </div>
      </div>
    </section>
  );
}
