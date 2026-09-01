import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { GarbageTrashIcon } from './garbage-parts';

interface GarbageEmptyStateProps {
  loading: boolean;
  progressLabel?: string;
  onScan: () => void;
}

/** 空态：引导扫描无用文件 */
export function GarbageEmptyState({ loading, progressLabel, onScan }: GarbageEmptyStateProps) {
  const t = useT();
  return (
    <PageShell
      illustration={<GarbageTrashIcon />}
      title={t('page.garbage.empty.title')}
      subtitle={t('page.garbage.empty.subtitle')}
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
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M9 15l6 6M15 15l-6 6" />
            </svg>
          ),
          title: t('page.garbage.type.unusedFile'),
          desc: t('page.garbage.feature.unusedFile.desc'),
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
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 21V9" />
            </svg>
          ),
          title: t('page.garbage.type.unusedDependency'),
          desc: t('page.garbage.feature.unusedDependency.desc'),
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
              <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
            </svg>
          ),
          title: t('page.garbage.type.deadCode'),
          desc: t('page.garbage.feature.deadCode.desc'),
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
              <path d="M8 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-2" />
              <path d="M16 2h6v6" />
              <path d="M11 13l9-9" />
              <path d="M20 4l-9 9" />
            </svg>
          ),
          title: t('page.garbage.type.duplicateCode'),
          desc: t('page.garbage.feature.duplicateCode.desc'),
        },
      ]}
      buttonText={t('page.garbage.startScan')}
      onAction={onScan}
      loading={loading}
      progressLabel={progressLabel || t('page.garbage.scanning')}
    />
  );
}
