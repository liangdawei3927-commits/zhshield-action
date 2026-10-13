import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { DomainScoreRing } from '../components/business/DomainScoreRing';
import { FeatureIcon, LockKeyIcon } from '../components/ui/Icons';
import type { ScanEmptyStateParams } from '../components/business/ScanEmptyState';

/** 空态：引导深度扫描（props 即 ScanEmptyStateBranch 的共享契约，由 SecurityPage 展开传递） */
export function SecurityEmptyState({
  projectPath,
  loading,
  progress,
  statusMessage,
  onScan,
}: ScanEmptyStateParams) {
  const t = useT();
  return (
    <PageShell
      illustration={<DomainScoreRing projectPath={projectPath} dimension="security" />}
      title={t('page.security.empty.title')}
      subtitle={t('page.security.empty.subtitle')}
      featureList={[
        {
          icon: (
            <FeatureIcon>
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </FeatureIcon>
          ),
          title: t('page.security.tab.vuln'),
          desc: t('page.security.feature.vuln.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <circle cx="12" cy="12" r="6.5" />
              <circle cx="12" cy="12" r="1.8" />
              <path d="M12 5.5V3" />
              <path d="M12 18.5V21" />
              <path d="M5.5 12H3" />
              <path d="M18.5 12H21" />
              <path d="M7.4 7.4L5.6 5.6" />
              <path d="M16.6 16.6l1.8 1.8" />
              <path d="M16.6 7.4l1.8-1.8" />
              <path d="M7.4 16.6l-1.8 1.8" />
            </FeatureIcon>
          ),
          title: t('page.security.tab.malware'),
          desc: t('page.security.feature.malware.desc'),
        },
        {
          icon: <LockKeyIcon />,
          title: t('page.security.feature.secrets.title'),
          desc: t('page.security.feature.secrets.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <polyline points="9 11 12 14 22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </FeatureIcon>
          ),
          title: t('page.security.feature.standard.title'),
          desc: t('page.security.feature.standard.desc'),
        },
      ]}
      buttonText={t('page.security.fixAll')}
      onAction={onScan}
      loading={loading}
      progress={progress}
      progressLabel={t('page.security.checking')}
      progressMessage={statusMessage}
    />
  );
}
