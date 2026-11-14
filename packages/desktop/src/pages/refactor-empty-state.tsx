import type { ComponentProps } from 'react';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import type { ScanEmptyStateParams } from '../components/business/ScanEmptyState';
import { FeatureIcon, LayersGlyph, GridGlyph } from '../components/ui/Icons';
import { buildCapabilityFeatures } from '../components/business/capability-features';
import { useT } from '../i18n';

/**
 * 空态 props：运行态字段（loading / progress / statusMessage / queued /
 * queuePosition / onCancel / stopping / onScan）复用全仓统一的空态契约
 * {@link ScanEmptyStateParams}，本域只补自己的 `error`。
 *
 * 此前这里把 8 个字段逐行重抄一遍，与 guard / inspect 的空态声明构成跨文件重复；
 * 该契约加字段时这几份手抄版会静默落后（`statusMessage` 改名那轮就差点漏）。
 */
interface EmptyStateProps extends ScanEmptyStateParams {
  error: string;
}

/** 构建重构空态的特色说明列表 */
function buildRefactorFeatures(
  t: ReturnType<typeof useT>,
): ComponentProps<typeof DomainEmptyView>['features'] {
  // 注册表决定**渲染哪几项**（只渲染 status='implemented' 的）。
  // 「一键应用推荐重构方案」（refactor.auto-fix）现已落地（2026-11-03）：
  // 桌面端入口 + 写盘前自动备份。注册表里 status 仍是 planned/deprecated 的
  // 能力不会出现在这里（空态也不再单列「能力边界」区）。
  // 「每日自动检查」「按类别分组」是运行形态而非检测能力，由页面自身承载，不入注册表。
  return buildCapabilityFeatures('refactor', {
    icons: {
      'refactor.smells': (
        <FeatureIcon>
          <LayersGlyph />
        </FeatureIcon>
      ),
      'refactor.duplicate-code': (
        <FeatureIcon>
          <GridGlyph />
        </FeatureIcon>
      ),
      'refactor.auto-fix': (
        <FeatureIcon>
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </FeatureIcon>
      ),
    },
    descriptions: {
      'refactor.smells': t('page.refactor.shell.featureSmell.desc'),
      'refactor.duplicate-code': t('page.refactor.shell.featureGrouping.desc'),
    },
  });
}

/** 空态：引导检查 */
export function RefactorEmptyState(props: EmptyStateProps) {
  const t = useT();
  return (
    <div className="h-full w-full relative">
      <DomainEmptyView
        projectPath={props.projectPath}
        domain="refactor"
        title={t('page.refactor.shell.title')}
        subtitle={t('page.refactor.shell.subtitle')}
        features={buildRefactorFeatures(t)}
        buttonText={t('page.refactor.scanNow')}
        onAction={props.onScan}
        actionDomain="refactor"
        queued={props.queued}
        queuePosition={props.queuePosition}
        onCancel={props.onCancel}
        stopping={props.stopping}
        loading={props.loading}
        progress={props.progress}
        statusMessage={props.statusMessage}
      />
      <div className="absolute bottom-24 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
        {props.error ? <p className="text-xs text-danger-500">{props.error}</p> : null}
      </div>
    </div>
  );
}
