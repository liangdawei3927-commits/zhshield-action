/**
 * 安全中心「报告视图」的展示件：统计卡、分类标签栏、报告外壳。
 *
 * 从 `SecurityPage.tsx` 按职责拆出（原文件超 400 行代码阈值）：
 * 本文件只负责"把已算好的报告画出来"。页面状态（扫描进度 / 快照 / 详情入口）
 * 与分类面板（漏洞 / 恶意代码 / 密钥）仍留在页面 —— 密钥面板留在页面是刻意的：
 * `secrets-error-surfaced` 守卫直接对页面源码断言「扫描错误必须接到列表卡」，
 * 把接线搬走等于绕过守卫。
 *
 * 分类明细经 `children` 插槽传入，渲染位置与拆分前完全一致（标签栏之下）。
 */

import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { FindingsPanel, MalwarePanel } from './security-parts';
import { ReportShell } from '../components/business/ReportShell';
import type { ReportStatCard } from '../components/business/ReportShell';
import { NavGlyph } from '../components/business/page-glyph';
import { DomainActionButton } from '../components/business/DomainActionButton';
import { SEVERITY_CONFIG } from './security-logic';
import type { SecurityIssue } from './security-logic';
import type { SecurityScanReportData, SecretReportData } from '../types/electron';

export type SecurityTab = 'vuln' | 'malware' | 'secrets';

export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** 分类标签：顺序即界面顺序（漏洞 / 恶意代码 / 密钥） */
const TABS: Array<{ id: SecurityTab; labelKey: string }> = [
  { id: 'vuln', labelKey: 'page.security.tab.vuln' },
  { id: 'malware', labelKey: 'page.security.tab.malware' },
  { id: 'secrets', labelKey: 'page.security.tab.secrets' },
];

/** 统计卡按此顺序展开严重级别；与 SEVERITY_CONFIG 的键一一对应 */
const SEVERITY_KEYS = ['critical', 'high', 'medium', 'low'] as const;

export interface SecurityReportCopyProps {
  copyToAi: (issue: SecurityIssue) => void;
  copyAllToAi: (issues: SecurityIssue[]) => void;
  copyMalwareToAi: (item: SecurityScanReportData['malware'][number]) => void;
  copyMalwareAllToAi: (items: SecurityScanReportData['malware']) => void;
}

export interface SecuritySecretsProps {
  onMarkRotating: (secretId: string) => void;
  onVerifyRotated: (secretId: string) => void;
  onDismiss: (secretId: string) => void;
  secretsCopyToAi: (finding: SecretReportData['findings'][number]) => void;
  secretsCopyAllToAi: (findings: SecretReportData['findings']) => void;
  t: Translate;
}

export function renderFindingsPanel(
  items: SecurityScanReportData['findings'],
  onCopyToAi: (issue: SecurityIssue) => void,
  onCopyAll: (issues: SecurityIssue[]) => void,
) {
  return <FindingsPanel findings={items} onCopyToAi={onCopyToAi} onCopyAll={onCopyAll} />;
}

export function renderMalwarePanel(
  items: SecurityScanReportData['malware'],
  onCopyToAi: (item: SecurityScanReportData['malware'][number]) => void,
  onCopyAll: (items: SecurityScanReportData['malware']) => void,
) {
  return <MalwarePanel items={items} onCopyToAi={onCopyToAi} onCopyAll={onCopyAll} />;
}

/** 报告统计卡：总数 + 各严重级别 + 恶意代码，明细复用 FindingsPanel/MalwarePanel */
export function buildSecurityStats({
  report,
  copyToAi,
  copyAllToAi,
  copyMalwareToAi,
  copyMalwareAllToAi,
  t,
}: {
  report: SecurityScanReportData;
  t: Translate;
} & SecurityReportCopyProps): ReportStatCard[] {
  return [
    { key: 'total', label: t('page.security.stats.total'), value: report.summary.total },
    ...SEVERITY_KEYS.map((sev) => {
      const items = report.findings.filter((f) => f.severity === sev);
      return {
        key: sev,
        label: t(`severity.${sev}`),
        value: report.summary[sev],
        // 与明细徽章同源（security-logic 的 SEVERITY_CONFIG）：一处定义、两处消费，
        // 避免统计卡与问题清单对同一严重级给出不同颜色。
        color: SEVERITY_CONFIG[sev]?.color,
        detail: {
          items,
          render: (sub: unknown[]) =>
            renderFindingsPanel(sub as SecurityScanReportData['findings'], copyToAi, copyAllToAi),
          hint: t('page.security.copyAllPrompt', { count: items.length }),
        },
      };
    }),
    {
      key: 'malware',
      label: t('page.security.stats.malware'),
      value: report.summary.malwareTotal,
      // 恶意代码属最高危，与 critical 同档
      color: 'rgb(var(--zh-danger-dark))',
      detail: {
        items: report.malware,
        render: (sub: unknown[]) =>
          renderMalwarePanel(
            sub as SecurityScanReportData['malware'],
            copyMalwareToAi,
            copyMalwareAllToAi,
          ),
      },
    },
  ];
}

/** 分类切换标签栏 */
export function SecurityTabBar({
  tab,
  onTabChange,
  t,
}: {
  tab: SecurityTab;
  onTabChange: (tab: SecurityTab) => void;
  t: Translate;
}) {
  return (
    <div className="flex gap-2 mb-6">
      {TABS.map((t2) => (
        <button
          key={t2.id}
          onClick={() => onTabChange(t2.id)}
          className={`px-4 py-2 rounded-lg text-sm font-medium border-none cursor-pointer transition-colors ${
            tab === t2.id
              ? 'bg-danger-600 text-white'
              : 'bg-zh-panel text-zh-ink-2 hover:bg-zh-line'
          }`}
        >
          {t(t2.labelKey)}
        </button>
      ))}
    </div>
  );
}

/** 报告外壳入参：密钥侧的回调已随明细面板一起留在页面，此处不再重复接一遍 */
export interface SecurityReportViewProps extends SecurityReportCopyProps {
  projectPath: string;
  report: SecurityScanReportData;
  loading: boolean;
  progress: number;
  statusMessage: string;
  /** 排队中：按钮显示「排队中…」而不是「检查中…」 */
  queued?: boolean;
  /** 停止本次安全检查（运行/排队时按钮旁出现「停止」） */
  onCancel: () => void;
  /** 已发出取消、等确认 */
  stopping: boolean;
  tab: SecurityTab;
  onTabChange: (tab: SecurityTab) => void;
  onRescan: () => void;
  onBackHome: () => void;
  /** 当前分类的明细面板：由页面装配后传入（渲染位置 = 标签栏之下） */
  children?: ReactNode;
}

/** P1-4：扫描降级横幅——工具不可用/审计失败时 0 检出 ≠ 安全，必须显形 */
function SecurityDegradedBanner({ report, t }: { report: SecurityScanReportData; t: Translate }) {
  if (!report.degraded) return null;
  const { unavailableTools, auditError } = report.degraded;
  const tools = unavailableTools.join(', ');
  return (
    <div className="mb-6 flex items-start gap-3 px-4 py-3 rounded-xl bg-warning-50 border border-warning-100">
      <div className="min-w-0">
        <div className="text-sm font-medium text-warning-700">
          {t('page.security.degraded.title')}
        </div>
        <div className="text-xs text-warning-500 mt-0.5 break-all">
          {t('page.security.degraded.detail', {
            tools: tools || t('page.security.degraded.none'),
            audit: auditError ?? '',
          })}
        </div>
      </div>
    </div>
  );
}

/** 报告态：统计卡 + 分类标签栏 + 明细面板（插槽） */
export function SecurityReportView({
  projectPath,
  report,
  loading,
  progress,
  statusMessage,
  queued,
  onCancel,
  stopping,
  tab,
  onTabChange,
  onRescan,
  onBackHome,
  copyToAi,
  copyAllToAi,
  copyMalwareToAi,
  copyMalwareAllToAi,
  children,
}: SecurityReportViewProps) {
  const t = useT();
  return (
    <ReportShell
      projectPath={projectPath}
      dimension="security"
      historyDomain="security"
      refreshKey={report}
      icon={<NavGlyph navId="security" />}
      title={t('page.security.done')}
      action={
        <DomainActionButton
          domain="security"
          onCancel={onCancel}
          stopping={stopping}
          queued={queued}
          onClick={onRescan}
          loading={loading}
          label={t('page.security.rescan')}
        />
      }
      onBackHome={onBackHome}
      loading={loading}
      progress={progress}
      progressMessage={statusMessage}
      stats={buildSecurityStats({
        report,
        copyToAi,
        copyAllToAi,
        copyMalwareToAi,
        copyMalwareAllToAi,
        t,
      })}
    >
      <SecurityDegradedBanner report={report} t={t} />
      <SecurityTabBar tab={tab} onTabChange={onTabChange} t={t} />
      {children}
    </ReportShell>
  );
}
