import { useT } from '../i18n';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { FeatureIcon } from '../components/ui/Icons';
import { buildCapabilityFeatures, buildPlannedCapabilities } from '../components/business/capability-features';
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
      features={buildCapabilityFeatures('garbage', {
        // 图标按能力 id 绑定：注册表决定**渲染哪几项**，图标只负责视觉。
        // 「重复代码」（garbage.duplicate-code）已从清单移除 —— 按《07》O1
        // 它唯一归重构域，垃圾页宣称它就是宣称了一件本域不做的事。
        icons: {
          'garbage.unused-file': (
            <FeatureIcon>
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h10a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M9 15l6 6M15 15l-6 6" />
            </FeatureIcon>
          ),
          'garbage.unused-dependency': (
            <FeatureIcon>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 21V9" />
            </FeatureIcon>
          ),
          'garbage.dead-code': (
            <FeatureIcon>
              <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
            </FeatureIcon>
          ),
        },
      })}
      planned={buildPlannedCapabilities('garbage')}
      buttonText={t('page.garbage.startScan')}
      onAction={props.onScan}
      actionDomain="garbage"
      {...scanRunProps(props)}
    />
  );
}
