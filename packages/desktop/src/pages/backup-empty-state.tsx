import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { FeatureIcon, LayersGlyph, GridGlyph } from '../components/ui/Icons';
import { useT } from '../i18n';
import type { BackupProgressData } from '../types/electron';

/** 空态：引导一键备份 */
export function BackupEmptyState({
  projectPath,
  isBackingUp,
  progress,
  onBackup,
}: {
  projectPath: string;
  isBackingUp: boolean;
  progress: BackupProgressData | null;
  onBackup: () => void;
}) {
  const t = useT();
  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <DomainEmptyView
        projectPath={projectPath}
        dimension="backup"
        title={t('page.backup.empty.title')}
        subtitle={t('page.backup.empty.lastBackup', { date: new Date().toLocaleString('zh-CN') })}
        features={[
          {
            icon: (
              <FeatureIcon>
                <LayersGlyph />
              </FeatureIcon>

            ),

            title: t('page.backup.empty.feature.config.title'),
            desc: t('page.backup.empty.feature.config.desc'),
          },
          {
            icon: (
              <FeatureIcon>
                <GridGlyph />
              </FeatureIcon>

            ),

            title: t('page.backup.empty.feature.rules.title'),
            desc: t('page.backup.empty.feature.rules.desc'),
          },
          {
            icon: (
              <FeatureIcon>
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
              </FeatureIcon>

            ),

            title: t('page.backup.empty.feature.sync.title'),
            desc: t('page.backup.empty.feature.sync.desc'),
          },
          {
            icon: (
              <FeatureIcon>
                <polyline points="23 4 23 10 17 10" />
                <path d="M3 14l3 3 3-3" />
              </FeatureIcon>

            ),

            title: t('page.backup.empty.feature.restore.title'),
            desc: t('page.backup.empty.feature.restore.desc'),
          },
        ]}
        buttonText={t('page.backup.oneClickBackup')}
        onAction={onBackup}
        loading={isBackingUp}
        progressLabel={t('page.backup.backingUp')}
        statusMessage={progress?.message}
        progress={progress?.percent ?? 0}
      />
    </div>
  );
}
