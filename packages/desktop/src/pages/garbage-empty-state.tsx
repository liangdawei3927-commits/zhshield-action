import { useT } from '../i18n';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { FeatureIcon } from '../components/ui/Icons';
import type { ScanEmptyStateParams } from '../components/business/ScanEmptyState';
import { scanRunProps } from '../components/business/ScanEmptyState';

/** 空态：引导扫描无用文件（props 即 ScanEmptyStateBranch 的共享契约，由 GarbagePage 展开传递） */
export function GarbageEmptyState(props: ScanEmptyStateParams) {
  const t = useT();
  return (
    <DomainEmptyView
      projectPath={props.projectPath}
      dimension="garbage"
      title={t('page.garbage.empty.title')}
      subtitle={t('page.garbage.empty.subtitle')}
      features={[
        {
          icon: (
            <FeatureIcon>
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M9 15l6 6M15 15l-6 6" />
            </FeatureIcon>
          ),
          title: t('page.garbage.type.unusedFile'),
          desc: t('page.garbage.feature.unusedFile.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 21V9" />
            </FeatureIcon>
          ),
          title: t('page.garbage.type.unusedDependency'),
          desc: t('page.garbage.feature.unusedDependency.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
            </FeatureIcon>
          ),
          title: t('page.garbage.type.deadCode'),
          desc: t('page.garbage.feature.deadCode.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <path d="M8 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-2" />
              <path d="M16 2h6v6" />
              <path d="M11 13l9-9" />
              <path d="M20 4l-9 9" />
            </FeatureIcon>
          ),
          title: t('page.garbage.type.duplicateCode'),
          desc: t('page.garbage.feature.duplicateCode.desc'),
        },
      ]}
      buttonText={t('page.garbage.startScan')}
      onAction={props.onScan}
      actionDomain="garbage"
      {...scanRunProps(props)}
    />
  );
}
