/**
 * 分类详情页的**标准外壳**（domain-report-shell.tsx）
 *
 * ## 为什么有这层
 *
 * 九个分类详情页（体检 / 门禁 / 安全 / 垃圾 / 性能 / 依赖 / 技术债 / 重构 / 哨兵）
 * 此前各自手写同一段结构：
 *
 * ```tsx
 * <ReportShell
 *   projectPath={projectPath}
 *   dimension="…"
 *   historyDomain="…"
 *   refreshKey={report}
 *   icon={<NavGlyph navId="…" />}
 *   title={t('…')}
 *   action={
 *     <DomainActionButton
 *       domain="…"
 *       onCancel={onCancel}
 *       stopping={stopping}
 *       queued={queued}
 *       onClick={onRescan}
 *       loading={loading}
 *       label={t('…')}
 *     />
 *   }
 *   onBackHome={onBackHome}
 *   stats={stats}
 * >
 *   {children}
 * </ReportShell>
 * ```
 *
 * 逐字相同的部分有十余行（按钮的六字段接线 + 外壳的八个 prop）。这类重复最危险
 * 的不是行数，而是**语义漂移**：按钮的 `queued` / `stopping` / `onCancel` 三字段
 * 若某个页面漏接一处，用户的「停止」入口就没了 —— 而这不会报错，只会静默失效。
 * 收进一个组件后，漏接变成编译期错误。
 *
 * ## 设计取舍
 *
 * 只收敛**确实逐字相同**的部分：
 *   · 外壳的 dimension / historyDomain / icon / title / action 装配 → 由本组件持有；
 *   · 主操作按钮的接线（loading / queued / stopping / onCancel / onClick / label）→ 同一处。
 *
 * 域特有的部分（评分维度名、图标、历史域、按钮文案、统计卡、明细区）仍由调用方传入 ——
 * 强行参数化反而会把差异藏进配置表，读者更难看出哪个域有什么不同。
 */
import type { ReactNode } from 'react';
import { ReportShell, type ReportShellProps, type ReportStatCard } from './ReportShell';
import { DomainActionButton } from './DomainActionButton';
import { NavGlyph } from './page-glyph';
import type { ActionRunningKey } from './domain-action-text';
import {
  DOMAIN_REPORT_META,
  defaultActionDomain,
  type ReportDomainKey,
} from '../../pages/domain-report-meta';

/**
 * @deprecated 主操作按钮的运行态接线已平铺进 {@link DomainReportShellProps}
 * （loading / queued / onCancel / stopping 四个字段），本类型不再使用。
 * 保留导出仅为兼容可能的外部引用。
 */
export type DomainActionState = {
  /** 运行中（含排队中） */
  loading: boolean;
  /** 排队中：按钮显示「排队中…」 */
  queued?: boolean;
  /** 停止本次扫描（运行/排队时按钮 hover 出「停止」） */
  onCancel?: () => void;
  /** 已发出取消、等确认：按钮显示「停止中…」并禁用 */
  stopping?: boolean;
};

export interface DomainReportShellProps extends Pick<ReportShellProps, 'refreshKey' | 'coverage'> {
  projectPath: string;
  /**
   * 所属分类域 —— 评分维度 / 历史域 / 顶行图标 / 按钮运行态文案都从
   * `DOMAIN_REPORT_META` 取，页面只声明「我是哪个域」。
   */
  domain: ReportDomainKey;
  /** 自定义顶行图标（优先于域默认图标） */
  icon?: ReactNode;
  /** 顶行标题 */
  title: string;
  /** 主操作按钮空闲态文案 */
  actionLabel: string;
  /** 主操作按钮点击（默认即「重新扫描」）；传 undefined 表示该状态下按钮不可点 */
  onAction?: () => void;
  /** 主操作按钮运行中（含排队中） */
  loading: boolean;
  /** 主操作按钮排队中：显示「排队中…」而不是动作文案 */
  queued?: boolean;
  /** 停止本次扫描（运行/排队时按钮 hover 出「停止」）；不传表示该域不可取消 */
  onCancel?: () => void;
  /** 已发出取消、等确认：按钮显示「停止中…」并禁用 */
  stopping?: boolean;
  /** 主操作按钮所属域覆盖（仅哨兵需要：监控中 vs 刷新中） */
  actionDomain?: ActionRunningKey;
  /** 返回主页 */
  onBackHome: () => void;
  /** 统计卡行 */
  stats?: ReportStatCard[];
  /** 明细区 */
  children?: ReactNode;
}

/**
 * 分类详情页标准外壳。
 *
 * 九个域页面共用；域特有的统计卡与明细区由调用方通过 `stats` / `children` 传入。
 */
export function DomainReportShell({
  projectPath,
  domain,
  refreshKey,
  coverage,
  icon,
  title,
  actionLabel,
  onAction,
  loading,
  queued,
  onCancel,
  stopping,
  actionDomain,
  onBackHome,
  stats,
  children,
}: DomainReportShellProps) {
  const meta = DOMAIN_REPORT_META[domain];
  // 安全页已在分类标签行右侧显示检查时间，顶行不再重复
  return (
    <ReportShell
      projectPath={projectPath}
      dimension={meta.dimension}
      historyDomain={meta.historyDomain}
      refreshKey={refreshKey}
      coverage={coverage}
      icon={icon ?? <NavGlyph navId={domain} />}
      title={title}
      action={
        <DomainActionButton
          domain={actionDomain ?? defaultActionDomain(domain)}
          onCancel={onCancel}
          stopping={stopping}
          queued={queued}
          onClick={onAction}
          loading={loading}
          label={actionLabel}
        />
      }
      onBackHome={onBackHome}
      stats={stats}
      showScannedAt={domain !== 'security'}
    >
      {children}
    </ReportShell>
  );
}
