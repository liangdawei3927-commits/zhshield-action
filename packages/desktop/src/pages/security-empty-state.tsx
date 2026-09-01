import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { RedShield } from './security-parts';

interface SecurityEmptyStateProps {
  loading: boolean;
  progressLabel?: string;
  onScan: () => void;
}

/** 空态：引导深度扫描 */
export function SecurityEmptyState({ loading, progressLabel, onScan }: SecurityEmptyStateProps) {
  const t = useT();
  return (
    <PageShell
      illustration={<RedShield />}
      title={t('page.security.empty.title')}
      subtitle={t('page.security.empty.subtitle')}
      featureList={[
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          ),
          title: t('page.security.tab.vuln'),
          desc: t('page.security.feature.vuln.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3" />
            </svg>
          ),
          title: t('page.security.tab.malware'),
          desc: t('page.security.feature.malware.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 7V4h16v3" />
              <path d="M9 20h6" />
              <path d="M12 4v16" />
            </svg>
          ),
          title: t('page.security.feature.dependency.title'),
          desc: t('page.security.feature.dependency.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 11 12 14 22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
          ),
          title: t('page.security.feature.standard.title'),
          desc: t('page.security.feature.standard.desc'),
        },
      ]}
      buttonText={t('page.security.fixAll')}
      onAction={onScan}
      loading={loading}
      progressLabel={progressLabel || t('page.security.checking')}
    />
  );
}
