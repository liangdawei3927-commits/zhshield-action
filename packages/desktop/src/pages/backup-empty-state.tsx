import { PageShell } from '../components/business/PageShell';
import { useT } from '../i18n';

/** 云朵上传 SVG（线性风格） */
export function CloudUpload() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      <circle cx="75" cy="75" r="65" fill="rgb(var(--zh-brand) / 0.05)" />
      {/* 云朵 */}
      <path d="M48 82c-8 0-14-6-14-14s6-14 14-14c2-10 12-17 22-15 4-9 14-14 23-11 9-4 20-1 24 8 5 2 8 7 8 12s-3 10-8 13l-69 21z" fill="rgb(var(--zh-brand) / 0.08)" stroke="rgb(var(--zh-brand))" strokeWidth="1.8" />
      {/* 上传箭头 */}
      <path d="M75 85V55" stroke="rgb(var(--zh-brand))" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M63 67l12-12 12 12" stroke="rgb(var(--zh-brand))" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** 空态：引导一键备份 */
export function BackupEmptyState({ isBackingUp, onBackup }: { isBackingUp: boolean; onBackup: () => void }) {
  const t = useT();
  return (
    <PageShell
      illustration={<CloudUpload />}
      title={t('page.backup.empty.title')}
      subtitle={t('page.backup.empty.lastBackup', { date: new Date().toLocaleString('zh-CN') })}
      featureList={[
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
          ),
          title: t('page.backup.empty.feature.config.title'),
          desc: t('page.backup.empty.feature.config.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          ),
          title: t('page.backup.empty.feature.rules.title'),
          desc: t('page.backup.empty.feature.rules.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
            </svg>
          ),
          title: t('page.backup.empty.feature.sync.title'),
          desc: t('page.backup.empty.feature.sync.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" /><path d="M3 14l3 3 3-3" />
            </svg>
          ),
          title: t('page.backup.empty.feature.restore.title'),
          desc: t('page.backup.empty.feature.restore.desc'),
        },
      ]}
      buttonText={t('page.backup.oneClickBackup')}
      onAction={onBackup}
      loading={isBackingUp}
    />
  );
}
