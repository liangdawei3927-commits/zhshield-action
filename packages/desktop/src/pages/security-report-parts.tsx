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
 *
 * 规则通道横幅（账本分类 + 三类提示条）已再拆至 `security-rule-channel.tsx`：
 * 本文件二次越过 400 行阈值（zhcheck oversized-file），而横幅只依赖报告里的
 * `ruleChannel` / `ruleLedger`，与统计卡、分类面板无耦合。
 */

import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { classifyRuleLedger, RuleLedgerList, type RuleLedgerEntry } from './security-rule-channel';
import { FindingsPanel, MalwarePanel } from './security-parts';
import { DomainReportShell } from '../components/business/domain-report-shell';
import type { ReportStatCard } from '../components/business/ReportShell';
import { ResultCard } from '../components/ui/ResultCard';
import { SEVERITY_CONFIG } from './security-logic';
import type { SecurityIssue } from './security-logic';
import type { SecurityScanReportData, SecretReportData } from '../types/electron';
import { SecurityTabBar, type SecurityTab, type Translate } from './security-tab-bar';
import { SecurityResultMeta } from './security-result-meta';

export type { SecurityTab, Translate } from './security-tab-bar';

/** 统计卡按此顺序展开严重级别；与 SEVERITY_CONFIG 的键一一对应 */
const SEVERITY_KEYS = ['critical', 'high', 'medium', 'low'] as const;
type SecuritySeverity = (typeof SEVERITY_KEYS)[number];

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

/** 汇总三类问题的严重度：漏洞 + 恶意代码 + 活跃密钥（密钥只计 active） */
function collectAllSeverities(
  report: SecurityScanReportData,
  secretsReport?: SecretReportData | null,
): SecuritySeverity[] {
  const activeSecrets = (secretsReport?.findings ?? []).filter(
    (finding) => finding.status === 'active',
  );
  return [
    ...report.findings.map((finding) => finding.severity),
    ...report.malware.map((item) => item.severity),
    ...activeSecrets
      .map((finding) => finding.severity)
      .filter((severity): severity is SecuritySeverity =>
        (SEVERITY_KEYS as readonly string[]).includes(severity),
      ),
  ];
}

/** 严重度卡：固定一套（0 也显示），与明细徽章同色 */
function buildSeverityCards(severities: SecuritySeverity[], t: Translate): ReportStatCard[] {
  return SEVERITY_KEYS.map((sev) => ({
    key: sev,
    label: t(`severity.${sev}`),
    value: severities.filter((severity) => severity === sev).length,
    // 与明细徽章同源（security-logic 的 SEVERITY_CONFIG）：一处定义、两处消费
    color: SEVERITY_CONFIG[sev]?.color,
  }));
}

/** 规则通道状态卡：未评估 / 跳过，明细可展开逐条 */
function buildRuleStatusCards(report: SecurityScanReportData, t: Translate): ReportStatCard[] {
  const ledger = report.ruleLedger ?? [];
  const { failed, skipped } = classifyRuleLedger(ledger);
  const degradedCount = ledger.length > 0 ? failed.length : (report.ruleChannel?.degraded ?? 0);
  const skippedCount = ledger.length > 0 ? skipped.length : (report.ruleChannel?.skipped ?? 0);
  return [
    {
      key: 'degraded',
      label: t('page.security.stats.degraded', { defaultValue: '未评估' }),
      value: degradedCount,
      color: degradedCount > 0 ? 'rgb(var(--zh-warning))' : undefined,
      ...(failed.length > 0
        ? {
            detail: {
              items: failed,
              render: (sub: unknown[]) => (
                <RuleLedgerList
                  entries={sub as RuleLedgerEntry[]}
                  tone="text-warning-600"
                  testId="security-stat-degraded"
                />
              ),
            },
          }
        : {}),
    },
    {
      key: 'skipped',
      label: t('page.security.stats.skipped', { defaultValue: '跳过' }),
      value: skippedCount,
      color: 'rgb(var(--zh-muted))',
      ...(skipped.length > 0
        ? {
            detail: {
              items: skipped,
              render: (sub: unknown[]) => (
                <RuleLedgerList
                  entries={sub as RuleLedgerEntry[]}
                  tone="text-zh-muted"
                  testId="security-stat-skipped"
                />
              ),
            },
          }
        : {}),
    },
  ];
}

/**
 * 豁免卡：被白名单接受的已知问题（不计分，但必须可见）。
 *
 * 为什么不静默丢弃：豁免与「漏报」在界面上长得一模一样，只给一个少了几条的
 * 列表，用户分不清是「查过且放过」还是「没查出来」。卡片给出计数，展开后逐条
 * 显示理由 / 责任人 / 到期日——这才是「接受风险」和「假装看不见」的分界。
 */
function buildSuppressedCard(report: SecurityScanReportData, t: Translate): ReportStatCard[] {
  const suppressed = report.suppressed ?? [];
  if (suppressed.length === 0) return [];
  return [
    {
      key: 'suppressed',
      label: t('page.security.stats.suppressed', { defaultValue: '已豁免' }),
      value: suppressed.length,
      color: 'rgb(var(--zh-muted))',
      detail: {
        items: suppressed,
        hint: t('page.security.suppressedHint', {
          defaultValue: '以下条目已由白名单接受风险，不计入评分；理由/责任人/到期见各行',
        }),
        render: (sub: unknown[]) => (
          <ul className="space-y-2" data-testid="security-stat-suppressed">
            {(sub as NonNullable<SecurityScanReportData['suppressed']>).map((item) => (
              <li key={`${item.ruleId}:${item.message}`} className="text-xs">
                <div className="font-medium text-zh-ink break-all">{item.message}</div>
                <div className="mt-0.5 text-zh-muted break-all">
                  {t('page.security.suppressedMeta', {
                    defaultValue: '理由：{{reason}} · 认领：{{operator}} · 到期：{{expires}}',
                    reason: item.reason || '—',
                    operator: item.operator || '—',
                    expires: item.expiresAt ? item.expiresAt.slice(0, 10) : '永久',
                  })}
                </div>
                <div className="mt-0.5 font-mono text-[11px] break-all text-zh-muted">
                  {item.ruleId}
                </div>
              </li>
            ))}
          </ul>
        ),
      },
    },
  ];
}

/**
 * 报告统计卡：本次扫描的**全部问题**（漏洞 + 恶意代码 + 活跃密钥）按严重度汇总，
 * 外加规则通道的两个状态计数（未评估 / 跳过）与白名单豁免计数。
 *
 * 与其他分区详情页保持一致：卡片是**固定一套**（0 也显示），不随问题数增减；
 * 规则状态在卡内可展开逐条，不再用整幅横幅压住正文。
 */
export function buildSecurityStats({
  report,
  secretsReport,
  t,
}: {
  report: SecurityScanReportData;
  secretsReport?: SecretReportData | null;
  t: Translate;
}): ReportStatCard[] {
  const severities = collectAllSeverities(report, secretsReport);
  return [
    {
      key: 'total',
      label: t('page.security.stats.totalAll', { defaultValue: '总问题' }),
      value: severities.length,
    },
    ...buildSeverityCards(severities, t),
    ...buildRuleStatusCards(report, t),
    ...buildSuppressedCard(report, t),
  ];
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
  /** 密钥扫描报告：顶部「总问题」按三类合计，密钥只计 active */
  secretsReport?: SecretReportData | null;
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
  secretsReport,
  scanError,
  isSavedResult,
  children,
}: SecurityReportViewProps) {
  const t = useT();
  // R6/C4：把规则账换算成本次覆盖，交给评分卡——有规则没评估时不得显示「优秀」
  const ledger = report.ruleLedger ?? [];
  const { failed, skipped } = classifyRuleLedger(ledger);
  // 按归属让位的规则不属于本域，不计入分母；本域该跑却没跑成的才压低覆盖
  const total = ledger.length - skipped.length;
  const run = Math.max(0, total - failed.length);
  const coverage = total > 0 ? { run, total } : undefined;
  // 检查时间放在分类标签同一行右侧：无论切到哪个 tab，都知道数据是什么时候扫的
  const timestamp = report.metadata?.timestamp;
  const scannedTime =
    timestamp && !Number.isNaN(new Date(timestamp).getTime())
      ? new Date(timestamp).toLocaleString()
      : null;
  // 标题先说实话：本次失败 / 上次保存 / 本次完成
  const title = scanError
    ? t('page.security.result.titleFailed', { defaultValue: '本次检查未完成' })
    : isSavedResult
      ? t('page.security.result.titleSaved', { defaultValue: '上次检查结果' })
      : t('page.security.done');
  return (
    <DomainReportShell
      projectPath={projectPath}
      domain="security"
      refreshKey={report}
      title={title}
      coverage={coverage}
      actionLabel={t('page.security.rescan')}
      onAction={onRescan}
      loading={loading}
      queued={queued}
      onCancel={onCancel}
      stopping={stopping}
      onBackHome={onBackHome}
      stats={buildSecurityStats({ report, secretsReport, t })}
    >
      <SecurityResultMeta report={report} scanError={scanError} t={t} />
      <SecurityDegradedBanner report={report} t={t} />
      <ResultCard variant="list" className="mb-2 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zh-line px-5 py-2">
          <SecurityTabBar tab={tab} onTabChange={onTabChange} t={t} />
          {scannedTime ? (
            <span className="text-[11px] whitespace-nowrap text-zh-muted">
              {t('page.reportShell.scannedAt', {
                defaultValue: '检查时间 {{time}}',
                time: scannedTime,
              })}
            </span>
          ) : null}
        </div>
        <div className="p-4">{children}</div>
      </ResultCard>
    </DomainReportShell>
  );
}
