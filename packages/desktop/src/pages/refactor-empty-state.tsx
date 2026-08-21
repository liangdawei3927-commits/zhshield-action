import { PageShell } from '../components/business/PageShell';
import { useT } from '../i18n';

/** 循环箭头 SVG（线性风格） */
export function LoopArrows() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-info) / 0.05)" />
      <path d="M65 40C55 40 40 50 40 65s10 25 25 25" stroke="rgb(var(--zh-info))" strokeWidth="3" strokeLinecap="round" fill="none" />
      <path d="M85 110c10 0 25-10 25-25s-10-25-25-25" stroke="rgb(var(--zh-info))" strokeWidth="3" strokeLinecap="round" fill="none" />
      <path d="M55 45l10-5-5 10z" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="2" strokeLinejoin="round" />
      <path d="M95 105l-10 5 5-10z" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="2" strokeLinejoin="round" />
      <rect x="65" y="62" width="20" height="26" rx="3" stroke="rgb(var(--zh-info))" strokeWidth="1.5" fill="rgb(var(--zh-info) / 0.06)" />
      <path d="M69 70l-3 5 3 5" stroke="rgb(var(--zh-info))" strokeWidth="1.3" strokeLinecap="round" fill="none" />
      <path d="M81 70l3 5-3 5" stroke="rgb(var(--zh-info))" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

interface EmptyStateProps {
  error: string;
  scanning: boolean;
  progressLabel?: string;
  onScan: () => void;
}

/** 空态：引导检查 */
export function RefactorEmptyState({ error, scanning, progressLabel, onScan }: EmptyStateProps) {
  const t = useT();
  return (
    <div className="h-full w-full relative">
      <PageShell
        illustration={<LoopArrows />}
        title={t('page.refactor.shell.title')}
        subtitle={t('page.refactor.shell.subtitle')}
        featureList={[
          {
            icon: (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
              </svg>
            ),
            title: t('page.refactor.shell.featureSmell.title'),
            desc: t('page.refactor.shell.featureSmell.desc'),
          },
          {
            icon: (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            ),
            title: t('page.refactor.shell.featureAutoFix.title'),
            desc: t('page.refactor.shell.featureAutoFix.desc'),
          },
          {
            icon: (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
            ),
            title: t('page.refactor.shell.featureDaily.title'),
            desc: t('page.refactor.shell.featureDaily.desc'),
          },
          {
            icon: (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            ),
            title: t('page.refactor.shell.featureGrouping.title'),
            desc: t('page.refactor.shell.featureGrouping.desc'),
          },
        ]}
        buttonText={t('page.refactor.scanNow')}
        onAction={onScan}
        loading={scanning}
        progressLabel={progressLabel || t('page.refactor.scanningEllipsis')}
      />
      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
        {error ? <p className="text-xs text-red-500">{error}</p> : null}
      </div>
    </div>
  );
}
