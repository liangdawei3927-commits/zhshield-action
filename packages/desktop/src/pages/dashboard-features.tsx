import { BounceCard } from '../components/ui/Bounce';
import { useT } from '../i18n';

/** 功能模块地图 — 让用户一眼知道有哪些能力 */
interface FeatureItem {
  id: string;
  titleKey: string;
  descKey: string;
  color: string;
  bg: string;
  icon: React.ReactNode;
}

const features: FeatureItem[] = [
  {
    id: 'inspect',
    titleKey: 'nav.inspect',
    descKey: 'page.dashboard.feature.inspect.desc',
    color: 'rgb(var(--zh-brand))',
    bg: 'rgb(var(--zh-brand) / 0.07)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /><path d="M11 8v3l2 1" />
      </svg>
    ),
  },
  {
    id: 'security',
    titleKey: 'nav.security',
    descKey: 'page.dashboard.feature.security.desc',
    color: 'rgb(var(--zh-danger))',
    bg: 'rgb(var(--zh-danger) / 0.07)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" /><path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
  {
    id: 'performance',
    titleKey: 'nav.performance',
    descKey: 'page.dashboard.feature.performance.desc',
    color: 'rgb(var(--zh-warning))',
    bg: 'rgb(var(--zh-warning) / 0.07)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
  },
  {
    id: 'refactor',
    titleKey: 'nav.refactor',
    descKey: 'page.dashboard.feature.refactor.desc',
    color: 'rgb(var(--zh-info))',
    bg: 'rgb(var(--zh-info) / 0.07)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 12l4-4-4-4" /><path d="M20 12l-4 4 4 4" /><path d="M14 4h-2a5 5 0 00-5 5v2" /><path d="M10 20h2a5 5 0 005-5v-2" />
      </svg>
    ),
  },
  {
    id: 'backup',
    titleKey: 'nav.backup',
    descKey: 'page.dashboard.feature.backup.desc',
    color: 'rgb(var(--zh-brand))',
    bg: 'rgb(var(--zh-brand) / 0.07)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="6" width="18" height="4" rx="1" /><rect x="5" y="10" width="14" height="9" rx="1" /><path d="M9 14h6" />
      </svg>
    ),
  },
  {
    id: 'reports',
    titleKey: 'nav.reports',
    descKey: 'page.dashboard.feature.reports.desc',
    color: 'rgb(var(--zh-info))',
    bg: 'rgb(var(--zh-info) / 0.07)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" />
      </svg>
    ),
  },
];

export function FeatureMap({ onNavigate }: { onNavigate: (page: string) => void }) {
  const t = useT();
  return (
    <div className="w-full mt-auto mb-6 flex flex-col items-center">
      <div className="flex items-stretch justify-between gap-3 w-full px-6">
        {features.map((f) => (
          <BounceCard
            as="button"
            key={f.id}
            onClick={() => onNavigate(f.id)}
            className="flex flex-1 min-w-0 items-center gap-3 text-left bg-zh-card hover:bg-zh-panel rounded-xl px-4 py-4 shadow-sm shadow-black/5 transition-all group cursor-pointer"
            style={{ border: '1px solid rgb(var(--zh-brand) / 0.5)' }}
          >
            <span
              className="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center transition-transform group-hover:scale-105"
              style={{ color: f.color, background: f.bg }}
            >
              {f.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zh-ink whitespace-nowrap">{t(f.titleKey)}</span>
              <span className="block text-[11px] text-zh-muted mt-0.5 leading-relaxed truncate">{t(f.descKey)}</span>
            </span>
          </BounceCard>
        ))}
      </div>
    </div>
  );
}
