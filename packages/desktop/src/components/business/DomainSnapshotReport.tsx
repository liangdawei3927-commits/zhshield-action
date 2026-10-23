/**
 * 「最近一次检查结果」页 —— 点分类页右上角详情入口后进入的只读视图。
 *
 * 存在的理由：该域在本次升级**之前**扫过，磁盘上只有归一化快照
 * （评分由它算出），没有完整报告。此时点详情应当立刻看到那次结果，
 * 而不是被追着重扫一遍（用户明确要求：有分就直接看上次结果）。
 *
 * 边界（诚实优先）：
 * - 只展示快照里真实存在的条目，不补造通过项、不推算「通过率」；
 * - 条目多时只渲染前 LIMIT 条，并显式告知被截断；
 * - 想拿完整报告（含通过项与域特有结构）时，由用户自己点「重新检查」。
 */

import type { ReactNode } from 'react';
import type { ScoreDimension } from '@zh/shared';
import { useT } from '../../i18n';
import { ReportShell } from './ReportShell';
import { ResultCard } from '../ui/ResultCard';
import { PrimaryButton } from '../ui/PrimaryButton';
import {
  SNAPSHOT_ENTRY_LIMIT,
  type SnapshotEntry,
  type SnapshotReport,
} from '../../pages/domain-snapshot-logic';

const SEVERITY_STYLE: Record<
  SnapshotEntry['severity'],
  { labelKey: string; color: string; bg: string }
> = {
  error: {
    labelKey: 'page.snapshotReport.error',
    color: 'rgb(var(--zh-danger))',
    bg: 'rgb(var(--zh-danger) / 0.1)',
  },
  warning: {
    labelKey: 'page.snapshotReport.warning',
    color: 'rgb(var(--zh-warning))',
    bg: 'rgb(var(--zh-warning) / 0.12)',
  },
  info: {
    labelKey: 'page.snapshotReport.info',
    color: 'rgb(var(--zh-muted))',
    bg: 'rgb(var(--zh-muted) / 0.12)',
  },
};

export interface DomainSnapshotReportProps {
  projectPath: string;
  dimension: ScoreDimension;
  /** 分类图标（调用方传入，保持与原报告页一致） */
  icon: ReactNode;
  snapshot: SnapshotReport | null;
  /** 首次读盘中 */
  loading: boolean;
  /** 「重新检查」是否进行中 */
  rescanning: boolean;
  onRescan: () => void;
  onBackHome: () => void;
}

/** 一行历史问题 */
function SnapshotEntryRow({ entry, last }: { entry: SnapshotEntry; last: boolean }) {
  const t = useT();
  const style = SEVERITY_STYLE[entry.severity];
  const meta = [entry.ruleId, entry.location].filter(Boolean).join(' · ');

  return (
    <div
      className="flex items-start gap-3 px-5 py-4"
      style={{ borderBottom: last ? 'none' : '1px solid rgb(var(--zh-line))' }}
    >
      <span
        className="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
        style={{ background: style.bg, color: style.color }}
      >
        {t(style.labelKey, { defaultValue: entry.severity })}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zh-ink break-words">{entry.title}</div>
        {meta && <div className="mt-1 text-xs text-zh-muted break-all">{meta}</div>}
        {entry.suggestion && (
          <div className="mt-1 text-xs text-zh-muted break-words">
            {t('page.snapshotReport.suggestion', { defaultValue: '建议' })}: {entry.suggestion}
          </div>
        )}
      </div>
      {entry.autoFixable && (
        <span className="shrink-0 text-[11px] text-brand-600">
          {t('page.snapshotReport.autoFixable', { defaultValue: '可自动修复' })}
        </span>
      )}
    </div>
  );
}

export function DomainSnapshotReport({
  projectPath,
  dimension,
  icon,
  snapshot,
  loading,
  rescanning,
  onRescan,
  onBackHome,
}: DomainSnapshotReportProps) {
  const t = useT();
  const entries = snapshot?.entries ?? [];
  const shown = entries.slice(0, SNAPSHOT_ENTRY_LIMIT);
  const truncated = entries.length > shown.length;
  const stamp = snapshot?.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : '';

  const stats = [
    {
      key: 'total',
      label: t('page.snapshotReport.total', { defaultValue: '问题总数' }),
      value: snapshot?.total ?? 0,
    },
    {
      key: 'error',
      label: t('page.snapshotReport.error', { defaultValue: '错误' }),
      value: snapshot?.error ?? 0,
      color: 'rgb(var(--zh-danger))',
    },
    {
      key: 'warning',
      label: t('page.snapshotReport.warning', { defaultValue: '警告' }),
      value: snapshot?.warning ?? 0,
      color: 'rgb(var(--zh-warning))',
    },
    {
      key: 'info',
      label: t('page.snapshotReport.info', { defaultValue: '提示' }),
      value: snapshot?.info ?? 0,
      color: 'rgb(var(--zh-muted))',
    },
  ];

  return (
    <ReportShell
      projectPath={projectPath}
      dimension={dimension}
      icon={icon}
      title={t('page.snapshotReport.title', { defaultValue: '最近一次检查结果' })}
      action={
        <PrimaryButton
          onClick={onRescan}
          loading={rescanning}
          loadingLabel={t('page.snapshotReport.rescanning', { defaultValue: '检查中' })}
        >
          {t('page.snapshotReport.rescan', { defaultValue: '重新检查' })}
        </PrimaryButton>
      }
      onBackHome={onBackHome}
      loading={rescanning}
      stats={stats}
    >
      <p className="text-xs text-zh-muted mb-4">
        {t('page.snapshotReport.notice', {
          defaultValue:
            '这是该分类最近一次检查保存下来的结果，页面评分就是由这些条目算出的。如需完整报告（含通过项等明细），请点「重新检查」。',
        })}
        {stamp ? ` · ${stamp}` : ''}
      </p>

      {loading && (
        <ResultCard variant="section" className="text-sm text-zh-muted">
          {t('page.snapshotReport.loading', { defaultValue: '正在读取最近一次结果…' })}
        </ResultCard>
      )}

      {!loading && !snapshot && (
        <ResultCard variant="section" className="text-sm text-zh-muted">
          {t('page.snapshotReport.unavailable', {
            defaultValue: '读取不到该分类的历史结果文件，请点「重新检查」生成一次。',
          })}
        </ResultCard>
      )}

      {!loading && snapshot && shown.length === 0 && (
        <ResultCard variant="section" className="text-sm text-zh-muted">
          {t('page.snapshotReport.empty', {
            defaultValue: '最近一次检查没有记录到问题条目。',
          })}
        </ResultCard>
      )}

      {shown.length > 0 && (
        <ResultCard variant="list" className="overflow-hidden">
          {shown.map((entry, index) => (
            <SnapshotEntryRow
              key={entry.key}
              entry={entry}
              last={index === shown.length - 1}
            />
          ))}
        </ResultCard>
      )}

      {truncated && (
        <p className="mt-3 text-xs text-zh-muted">
          {t('page.snapshotReport.truncated', {
            defaultValue: '仅显示前 {{shown}} 条，共 {{total}} 条。',
            shown: shown.length,
            total: entries.length,
          })}
        </p>
      )}
    </ReportShell>
  );
}
