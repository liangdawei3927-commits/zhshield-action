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
import { DomainReportShell } from '../components/business/domain-report-shell';
import type { ReportStatCard } from '../components/business/ReportShell';
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

import type { AsyncScanViewProps } from './async-scan-props';

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
export interface SecurityReportViewProps extends SecurityReportCopyProps, AsyncScanViewProps {
  projectPath: string;
  report: SecurityScanReportData;
  tab: SecurityTab;
  onTabChange: (tab: SecurityTab) => void;
  onRescan: () => void;
  onBackHome: () => void;
  /**
   * 本次「重新检查」的失败原因（超时/工具被杀/执行器抛错）。
   *
   * 失败时渲染层拿不到新报告，页面会回落到 `.zhshield/reports/security.json`
   * 里的**上一次**结果；若不显形，用户会把那份旧结果当成「刚刚检查完成」——
   * 2026-11-09 实测：扫描 120s 超时、页面仍显示旧报告的 100 分「优秀」。
   */
  scanError?: string | null;
  /** 当前展示的报告是否来自磁盘（本会话没产出新结果） */
  isSavedResult?: boolean;
  /** 当前分类的明细面板：由页面装配后传入（渲染位置 = 标签栏之下） */
  children?: ReactNode;
}

/** 报告结果的出处与时间：新结果 / 上次保存的旧结果 / 本次失败 三态必须可区分 */
function SecurityResultMeta({
  report,
  scanError,
  isSavedResult,
  t,
}: {
  report: SecurityScanReportData;
  scanError?: string | null;
  isSavedResult?: boolean;
  t: Translate;
}) {
  const time = report.metadata?.timestamp
    ? new Date(report.metadata.timestamp).toLocaleString()
    : t('page.security.result.unknownTime', { defaultValue: '时间未知' });

  if (scanError) {
    return (
      <div className="mb-4 px-4 py-3 rounded-xl bg-danger-50 border border-danger-100">
        <div className="text-sm font-medium text-danger-700">
          {t('page.security.result.failedTitle', {
            defaultValue: '本次检查未完成：{{error}}',
            error: scanError,
          })}
        </div>
        <div className="text-xs text-danger-500 mt-0.5">
          {t('page.security.result.failedDetail', {
            defaultValue: '下方显示的是 {{time}} 保存的旧结果，不代表本次扫描；修复后请重新检查。',
            time,
          })}
        </div>
      </div>
    );
  }

  if (isSavedResult) {
    return (
      <div className="mb-4 px-4 py-3 rounded-xl bg-warning-50 border border-warning-100">
        <div className="text-xs text-warning-700">
          {t('page.security.result.savedOnly', {
            defaultValue: '以下为上次保存的扫描结果（{{time}}），本次未产出新结果。',
            time,
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 text-xs text-zh-muted">
      {t('page.security.result.scannedAt', { defaultValue: '扫描时间：{{time}}', time })}
    </div>
  );
}

/**
 * 规则通道求值账横幅：有规则没评估成 → 0 检出 ≠ 干净。
 *
 * 与工具级 {@link SecurityDegradedBanner} 分开：这里是「规则没能评估」
 * （规则通道未执行 / 规则降级），不是工具不可用。混在一起会让用户按
 * 「重装工具」去修一个其实是规则/项目前提的问题。
 */
/** 账本条目类型（从报告类型派生，避免第二份形状定义） */
type RuleLedgerEntry = NonNullable<SecurityScanReportData['ruleLedger']>[number];

/**
 * 把账本分成页面上的两个桶：未能评估 / 按项目前提跳过。
 *
 * 纯函数：判定规则只有一处，渲染层不再各自 filter（否则两处口径迟早分叉）。
 */
export function classifyRuleLedger(ledger: readonly RuleLedgerEntry[]): {
  failed: RuleLedgerEntry[];
  skipped: RuleLedgerEntry[];
} {
  const failed = ledger.filter((entry) => entry.status === 'error' || entry.degraded === true);
  const skipped = ledger.filter((entry) => entry.status === 'skipped' && entry.degraded !== true);
  return { failed, skipped };
}

/** 逐条规则明细列表（两个桶共用；颜色与测试标记由调用方给） */
function RuleLedgerList({
  entries,
  tone,
  testId,
}: {
  entries: readonly RuleLedgerEntry[];
  tone: string;
  testId: string;
}) {
  if (entries.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {entries.map((entry, index) => (
        <li key={`${entry.ruleId}-${index}`} className={`text-xs ${tone} break-all`} data-testid={testId}>
          <span className="font-medium">{entry.ruleId}</span>
          {entry.reason ? ` — ${entry.reason}` : ''}
        </li>
      ))}
    </ul>
  );
}

/** 通道未执行：danger 条（只跑启发式时 0 检出 ≠ 干净） */
function ChannelNotRunNotice({ t }: { t: Translate }) {
  return (
    <div className="px-4 py-3 rounded-xl bg-danger-50 border border-danger-100">
      <div className="text-xs text-danger-700">
        {t('page.security.result.ruleChannelNotRun', {
          defaultValue:
            '规则通道本次未执行：只跑了启发式通道，0 检出不代表代码干净。请查看扫描日志确认规则集是否加载失败。',
        })}
      </div>
    </div>
  );
}

/** 未能评估：warning 条 + 逐条原因（旧报告无明细时明确标注，不冒充完整） */
function DegradedRulesNotice({
  count,
  entries,
  t,
}: {
  count: number;
  entries: readonly RuleLedgerEntry[];
  t: Translate;
}) {
  return (
    <div className="px-4 py-3 rounded-xl bg-warning-50 border border-warning-100">
      <div className="text-xs font-medium text-warning-700">
        {t('page.security.result.ruleChannelDegraded', {
          defaultValue:
            '{{count}} 条规则未能评估——未检测不等于通过。逐条原因见下，可据此判断是缺工具、缺适配器，还是规则本身跑不成。',
          count,
        })}
      </div>
      {entries.length > 0 ? (
        <RuleLedgerList entries={entries} tone="text-warning-600" testId="security-rule-degraded" />
      ) : (
        <div className="mt-1 text-xs text-warning-500">
          {t('page.security.result.ruleChannelNoLedger', {
            defaultValue: '逐条明细未知（该报告由旧版本产出）。',
          })}
        </div>
      )}
    </div>
  );
}

/** 按项目前提跳过：中性条、默认折叠（既定裁剪 ≠ 故障，重装工具对它无效） */
function SkippedRulesNotice({
  count,
  entries,
  t,
}: {
  count: number;
  entries: readonly RuleLedgerEntry[];
  t: Translate;
}) {
  return (
    <details className="px-4 py-3 rounded-xl bg-info-50 border border-info-100">
      <summary className="text-xs text-info-700 cursor-pointer">
        {t('page.security.result.ruleChannelSkipped', {
          defaultValue: '{{count}} 条规则按项目前提跳过（本项目不适用，不是故障）。',
          count,
        })}
      </summary>
      <RuleLedgerList entries={entries} tone="text-info-500" testId="security-rule-skipped" />
    </details>
  );
}

export function SecurityRuleChannelBanner({
  report,
  t,
}: {
  report: SecurityScanReportData;
  t: Translate;
}) {
  const channel = report.ruleChannel;
  const ledger = report.ruleLedger ?? [];
  const hasLedger = ledger.length > 0;
  const { failed, skipped } = classifyRuleLedger(ledger);
  const degradedCount = hasLedger ? failed.length : (channel?.degraded ?? 0);
  const skippedCount = hasLedger ? skipped.length : (channel?.skipped ?? 0);
  if (!channel && !hasLedger) return null;
  if (channel?.ran !== false && degradedCount === 0 && skippedCount === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {channel?.ran === false ? <ChannelNotRunNotice t={t} /> : null}
      {degradedCount > 0 ? <DegradedRulesNotice count={degradedCount} entries={failed} t={t} /> : null}
      {skippedCount > 0 ? <SkippedRulesNotice count={skippedCount} entries={skipped} t={t} /> : null}
    </div>
  );
}

/**
 * P1-4：扫描降级横幅——工具不可用/审计失败时 0 检出 ≠ 安全，必须显形。
 *
 * 「范围外跳过」单独成块、用中性色：工具本体可用只是当前项目不适用（如无
 * package.json 的文档仓库扫 trivy/depcheck），属既定裁剪。与降级混桶会让
 * 用户按「恢复工具/联网」去做无效动作，也会把真实降级淹没成背景噪音。
 */
function SecurityDegradedBanner({ report, t }: { report: SecurityScanReportData; t: Translate }) {
  const skipped = report.skippedTools ?? [];
  if (!report.degraded && skipped.length === 0) return null;

  return (
    <div className="mb-6 space-y-2">
      {report.degraded ? (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-warning-50 border border-warning-100">
          <div className="min-w-0">
            <div className="text-sm font-medium text-warning-700">
              {t('page.security.degraded.title')}
            </div>
            <div className="text-xs text-warning-500 mt-0.5 break-all">
              {t('page.security.degraded.detail', {
                tools:
                  report.degraded.unavailableTools.join(', ') || t('page.security.degraded.none'),
                audit: report.degraded.auditError ?? '',
              })}
            </div>
          </div>
        </div>
      ) : null}
      {skipped.length > 0 ? (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-info-50 border border-info-100">
          <div className="min-w-0">
            <div className="text-sm font-medium text-info-700">
              {t('page.security.skipped.title')}
            </div>
            <div className="text-xs text-info-500 mt-0.5 break-all">
              {t('page.security.skipped.detail', {
                tools: skipped.map((s) => s.tool).join(', '),
              })}
            </div>
            <ul className="mt-1.5 space-y-0.5">
              {skipped.map((s) => (
                <li key={s.tool} className="text-xs text-info-500 break-all">
                  {s.tool}：{s.reason}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 报告态：统计卡 + 分类标签栏 + 明细面板（插槽） */
export function SecurityReportView({
  projectPath,
  report,
  loading,
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
  scanError,
  isSavedResult,
  children,
}: SecurityReportViewProps) {
  const t = useT();
  return (
    <DomainReportShell
      projectPath={projectPath}
      domain="security"
      refreshKey={report}
      title={t('page.security.done')}
      actionLabel={t('page.security.rescan')}
      onAction={onRescan}
      loading={loading}
      queued={queued}
      onCancel={onCancel}
      stopping={stopping}
      onBackHome={onBackHome}
      stats={buildSecurityStats({
        report,
        copyToAi,
        copyAllToAi,
        copyMalwareToAi,
        copyMalwareAllToAi,
        t,
      })}
    >
      <SecurityResultMeta report={report} scanError={scanError} isSavedResult={isSavedResult} t={t} />
      <SecurityRuleChannelBanner report={report} t={t} />
      <SecurityDegradedBanner report={report} t={t} />
      <SecurityTabBar tab={tab} onTabChange={onTabChange} t={t} />
      {children}
    </DomainReportShell>
  );
}
