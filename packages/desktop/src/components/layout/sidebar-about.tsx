import { SectionTitle } from './sidebar-interactive';
import { BounceCard } from '../ui/Bounce';
import { useT, useI18n, SUPPORTED_LANGUAGES } from '../../i18n';
import { useTheme, type ThemeName } from '../../hooks/useTheme';

const THEME_OPTIONS: { value: ThemeName; labelKey: string; icon: string }[] = [
  { value: 'teal', labelKey: 'layout.themeTeal', icon: '💠' },
  { value: 'legacy', labelKey: 'layout.themeLegacy', icon: '🌲' },
  { value: 'dracula', labelKey: 'layout.themeDracula', icon: '🌙' },
];

export function ThemeSection() {
  const t = useT();
  const { theme, setTheme } = useTheme();
  return (
    <section>
      <SectionTitle
        label={t('layout.theme')}
        icon={
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
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
              {theme === option.value && <div className="w-2 h-2 rounded-full bg-[rgb(var(--zh-brand))]" />}
            </div>
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={theme === option.value}
              onChange={() => setTheme(option.value)}
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
  return (
    <section>
      <SectionTitle
        label={t('layout.language')}
        icon={
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
          </svg>
        }
      />
      <BounceCard className="rounded-xl bg-zh-panel/60 p-3 space-y-1.5">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            type="button"
            onClick={() => void setLanguage(lang.code)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer hover:bg-zh-panel transition-colors border-none bg-transparent text-left"
          >
            <span className="text-xs text-zh-ink-2 flex-1">{lang.nativeName}</span>
            <div className="w-4 h-4 rounded-full border-2 border-zh-line flex items-center justify-center">
              {language === lang.code && <div className="w-2 h-2 rounded-full bg-green-700" />}
            </div>
          </button>
        ))}
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
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
        }
      />
      <div className="px-3 py-2">
        <div className="text-xs text-zh-muted">{t('layout.aboutVersion', { version: 'v0.1.0' })}</div>
        <div className="text-[11px] text-zh-muted mt-1">{t('layout.brandSlogan')}</div>
      </div>
    </section>
  );
}
