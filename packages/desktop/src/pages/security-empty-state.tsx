import { useT } from '../i18n';
import { DomainEmptyView } from '../components/business/DomainEmptyView';
import { FeatureIcon, LockKeyIcon } from '../components/ui/Icons';
import {
  buildCapabilityFeatures,
  buildPlannedCapabilities,
} from '../components/business/capability-features';
import type { ScanEmptyStateParams } from '../components/business/ScanEmptyState';
import { scanRunProps } from '../components/business/ScanEmptyState';
import { SECURITY_PLANNED_DESCRIPTIONS } from './security-logic';

/**
 * 能力图标表（按能力 id 绑定）：注册表决定**渲染哪几项**，图标只负责视觉。
 *
 * ⚠️ 注册表里 7 项 implemented 必须**全部**绑定图标：缺一个就会在功能网格里
 * 留下一个空白灰块（缺省分支返回空 <span />，见 capability-features.tsx）。
 * 2026-11-09 实测：命令注入 / CSRF / 路径穿越三项漏绑，卡片渲染成空白。
 */
const SECURITY_CAPABILITY_ICONS = {
  'security.vuln.sql-injection': (
    <FeatureIcon>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </FeatureIcon>
  ),
  'security.vuln.xss': (
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
  'security.vuln.command-injection': (
    <FeatureIcon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <path d="M12.5 15H17" />
    </FeatureIcon>
  ),
  'security.vuln.csrf': (
    <FeatureIcon>
      <path d="M4 7l4-4 4 4" />
      <path d="M4 7h12a4 4 0 014 4" />
      <path d="M20 17l-4 4-4-4" />
      <path d="M20 17H8a4 4 0 01-4-4" />
    </FeatureIcon>
  ),
  'security.vuln.path-traversal': (
    <FeatureIcon>
      <path d="M3 7a2 2 0 012-2h4l2 3h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <path d="M10 14h6" />
      <path d="M13.5 11l3 3-3 3" />
    </FeatureIcon>
  ),
  'security.secrets': <LockKeyIcon />,
  'security.malware': (
    <FeatureIcon>
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </FeatureIcon>
  ),
  // 合规基线：清单 + 勾（只读映射，不是新扫描面）
  'security.compliance': (
    <FeatureIcon>
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <polyline points="9 14 11 16 15 12" />
    </FeatureIcon>
  ),
} as const;

/** 规划中/已移交项的用户可读说明：与报告页共用同一份（见 security-logic） */

/** 上一次「检查」失败时不能静默：页面上还挂着旧分数，用户会以为刚查过 */
function SecurityScanErrorNotice({ error }: { error: string }) {
  const t = useT();
  return (
    <div
      className="mt-4 max-w-2xl px-4 py-3 rounded-xl bg-danger-50 border border-danger-100 text-left"
      data-testid="security-scan-error"
    >
      <div className="text-sm font-medium text-danger-700">
        {t('page.security.result.failedTitle', {
          defaultValue: '本次检查未完成：{{error}}',
          error,
        })}
      </div>
      <div className="text-xs text-danger-500 mt-0.5">
        {t('page.security.result.failedHintShort', {
          defaultValue: '上方分数来自上一次保存的结果，不代表本次扫描。',
        })}
      </div>
    </div>
  );
}

/** 空态：引导深度扫描（props 即 ScanEmptyStateBranch 的共享契约，由 SecurityPage 展开传递） */
export function SecurityEmptyState(props: ScanEmptyStateParams & { scanError?: string | null }) {
  const t = useT();
  return (
    <DomainEmptyView
      projectPath={props.projectPath}
      domain="security"
      title={t('page.security.empty.title')}
      subtitle={t('page.security.empty.subtitle')}
      extra={props.scanError ? <SecurityScanErrorNotice error={props.scanError} /> : undefined}
      features={buildCapabilityFeatures('security', {
        icons: SECURITY_CAPABILITY_ICONS,
        descriptions: {
          'security.compliance': t('page.security.feature.compliance.desc', {
            defaultValue: '合规基线（ASVS L1 子集）：汇总各域已落盘结论的只读差距报告，不新增扫描',
          }),
        },
      })}
      planned={buildPlannedCapabilities('security', SECURITY_PLANNED_DESCRIPTIONS)}
      buttonText={t('page.security.fixAll')}
      onAction={props.onScan}
      actionDomain="security"
      {...scanRunProps(props)}
    />
  );
}
