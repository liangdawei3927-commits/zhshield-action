import type { ComponentProps } from 'react';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { FeatureIcon, LayersGlyph, GridGlyph } from '../components/ui/Icons';
import { useT } from '../i18n';
import type { BackupProgressData } from '../types/electron';

/** 构建备份空态的特色说明列表 */
function buildBackupFeatures(
  t: ReturnType<typeof useT>,
): ComponentProps<typeof DomainEmptyView>['features'] {
  return [
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
  ];
}

/** 空态：引导一键备份 */
export function BackupEmptyState({
  projectPath,
  isBackingUp,
  isStopping,
  progress,
  onBackup,
  onStopBackup,
}: {
  projectPath: string;
  isBackingUp: boolean;
  isStopping: boolean;
  progress: BackupProgressData | null;
  onBackup: () => void;
  onStopBackup: () => void;
}) {
  const t = useT();
  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <DomainEmptyView
        projectPath={projectPath}
        dimension="backup"
        title={t('page.backup.empty.title')}
        // 副标题只讲能力，不报「上次备份」：本组件同时充当分类主页（showHome=true），
        // 有历史记录时也会渲染。此前传的是 `new Date()` 现编时间 —— 从未备份过也显示
        // 「上次备份：刚刚」，且看不出是假的。真实上次备份时间由详情页的记录面板承担。
        subtitle={t('page.backup.empty.subtitle')}
        features={buildBackupFeatures(t)}
        buttonText={t('page.backup.oneClickBackup')}
        onAction={onBackup}
        actionDomain="backup"
        loading={isBackingUp}
        // 备份中：同一颗按钮 hover 出「停止」（此前一键备份点了就只能等它跑完）
        onCancel={isBackingUp ? onStopBackup : undefined}
        stopping={isStopping}
        statusMessage={progress?.message}
        // 单位换算：kernel 推的 percent 是 0..100（orchestrator 发 40/70/100），
        // 而 DomainEmptyView/PageShell 的 progress 契约是 0..1，由 DomainScanProgress 收口 ×100。
        // 此前直接透传 percent ⇒ 40×100 被 clamp 成 100，备份进度条一出现就是满条。
        progress={(progress?.percent ?? 0) / 100}
      />
    </div>
  );
}
