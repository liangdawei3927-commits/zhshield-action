/**
 * 报告中心的「日 / 周 / 月 / 年报」区块。
 *
 * 只做渲染：所有窗口归属与 delta 计算都在 `report-windows.ts`（已单测覆盖），
 * 这里不重新算一遍，避免「页面和测试各算一套」。
 *
 * 三条显示纪律：
 * - 期内变化（delta）与较上期变化（deltaVsPrevWindow）分开两列，不合并；
 * - 未检测维度显示占位符，不按「跌了 0 分」渲染；
 * - 只有 1 个窗口时不显示趋势结论 —— 单点不能算趋势。
 *
 * 第四条（数据缺口）：**凡是跨过断档的比较，必须当场标明它跨了多久**。
 * 只列有数据的窗口会把 41 天空档折叠掉，让「跨 45 天的变化」看起来像「一个月的变化」。
 * 所以结论条同时给覆盖率与最大空档，缺口行单独标色、并注明「较上期」的真实跨度。
 */

import { useMemo, useState } from 'react';
import type { HealthScoreData } from '../types/electron';
import {
  buildWindowBuckets,
  summarizeWindows,
  type WindowBucket,
  type WindowGranularity,
} from './report-windows';
import { deltaColor, dimensionName, formatDelta, getScoreColor } from './reports-logic';
import { AttributionSection } from './report-attribution-parts';
import { ResultCard } from '../components/ui/ResultCard';
import { useT } from '../i18n';

const GRANULARITIES: WindowGranularity[] = ['day', 'week', 'month', 'year'];

function GranularityTabs({
  value,
  onChange,
}: {
  value: WindowGranularity;
  onChange: (next: WindowGranularity) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5">
      {GRANULARITIES.map((item) => {
        const active = item === value;
        return (
          <button
            key={item}
            type="button"
            onClick={() => onChange(item)}
            className="px-3 py-1.5 rounded-md text-xs transition-colors"
            style={{
              background: active ? 'rgb(var(--zh-primary) / 0.12)' : 'transparent',
              color: active ? 'rgb(var(--zh-primary-dark))' : 'rgb(var(--zh-muted))',
              border: `1px solid ${active ? 'rgb(var(--zh-primary) / 0.4)' : 'rgb(var(--zh-line))'}`,
            }}
          >
            {t(`page.reports.window.granularity.${item}`, {
              defaultValue: { day: '日报', week: '周报', month: '月报', year: '年报' }[item],
            })}
          </button>
        );
      })}
    </div>
  );
}

type WindowSummaryData = NonNullable<ReturnType<typeof summarizeWindows>>;

/** 覆盖率：按整百分比显示；100% 时不标色，低于 50% 提示「这段时间大部分没被观测」 */
function CoverageItem({ summary }: { summary: WindowSummaryData }) {
  const t = useT();
  const coveragePct = Math.round(summary.coverage * 100);
  const color =
    coveragePct >= 100
      ? 'rgb(var(--zh-text))'
      : coveragePct >= 50
        ? 'rgb(var(--zh-muted))'
        : 'rgb(var(--zh-danger))';
  return (
    <span className="text-zh-muted">
      {t('page.reports.window.coverage', { defaultValue: '覆盖率' })}{' '}
      <span className="font-bold" style={{ color }}>
        {coveragePct}%
      </span>
    </span>
  );
}

/** 最大空档：有缺口时标红，并点明断在哪个窗口 */
function MaxGapItem({ summary }: { summary: WindowSummaryData }) {
  const t = useT();
  if (summary.maxGapDays === null || summary.maxGapDays <= 0) return null;
  return (
    <span className="text-zh-muted">
      {t('page.reports.window.maxGap', { defaultValue: '最大空档' })}{' '}
      <span
        className="font-bold"
        style={{ color: summary.gapCount > 0 ? 'rgb(var(--zh-danger))' : 'rgb(var(--zh-text))' }}
      >
        {summary.maxGapDays} {t('page.reports.window.dayUnit', { defaultValue: '天' })}
      </span>
      {summary.maxGapWindow && (
        <span className="text-zh-muted"> · {summary.maxGapWindow.key}</span>
      )}
    </span>
  );
}

/** 波峰 / 波谷：两端分别按分档上色 */
function BestWorstItem({ summary }: { summary: WindowSummaryData }) {
  const t = useT();
  return (
    <span className="text-zh-muted">
      {t('page.reports.window.bestWorst', { defaultValue: '最高 / 最低' })}{' '}
      <span className="font-bold" style={{ color: getScoreColor(summary.bestScore) }}>
        {summary.bestScore}
      </span>
      <span className="text-zh-muted"> / </span>
      <span className="font-bold" style={{ color: getScoreColor(summary.worstScore) }}>
        {summary.worstScore}
      </span>
    </span>
  );
}

/** 跌幅最大的窗口（含「较上期」的真实差值） */
function WorstDropItem({ summary }: { summary: WindowSummaryData }) {
  const t = useT();
  if (!summary.worstWindow) return null;
  return (
    <span className="text-zh-muted">
      {t('page.reports.window.worstDrop', { defaultValue: '跌幅最大' })}{' '}
      <span className="font-bold text-zh-text">{summary.worstWindow.label}</span>{' '}
      <span style={{ color: deltaColor(summary.worstWindow.deltaVsPrevWindow ?? 0) }}>
        {formatDelta(summary.worstWindow.deltaVsPrevWindow)}
      </span>
    </span>
  );
}

/** 结论条：窗口数 / 扫描次数 / 总变化 / 最好最差 / **可观测性（覆盖率与最大空档）** */
function WindowSummary({ buckets }: { buckets: readonly WindowBucket[] }) {
  const t = useT();
  const summary = useMemo(() => summarizeWindows(buckets), [buckets]);
  if (!summary) {
    return (
      <p className="text-xs text-zh-muted mb-3">
        {t('page.reports.window.insufficient', {
          defaultValue: '目前只有 1 个时间窗的记录，还不足以比较趋势。再积累一次检查后这里会显示变化。',
        })}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-2 text-xs">
      <span className="text-zh-muted">
        {t('page.reports.window.windows', { defaultValue: '窗口' })}{' '}
        <span className="font-bold text-zh-text">{summary.windows}</span>
        <span className="text-zh-muted"> / {summary.expectedWindows}</span>
      </span>
      <CoverageItem summary={summary} />
      <span className="text-zh-muted">
        {t('page.reports.window.scans', { defaultValue: '累计检查' })}{' '}
        <span className="font-bold text-zh-text">{summary.scans}</span>
      </span>
      <span className="text-zh-muted">
        {t('page.reports.window.span', { defaultValue: '跨度' })}{' '}
        <span className="font-bold text-zh-text">
          {summary.spanDays} {t('page.reports.window.dayUnit', { defaultValue: '天' })}
        </span>
      </span>
      <MaxGapItem summary={summary} />
      <span className="text-zh-muted">
        {t('page.reports.window.totalDelta', { defaultValue: '区间总变化' })}{' '}
        <span className="font-bold" style={{ color: deltaColor(summary.totalDelta) }}>
          {formatDelta(summary.totalDelta)}
        </span>
      </span>
      <BestWorstItem summary={summary} />
      <WorstDropItem summary={summary} />
    </div>
  );
}

/**
 * 断档警示条。
 *
 * 只在真有缺口时出现 —— 平时不占版面，出现时说明「下面哪个数字不能按字面读」。
 * 文案必须点明两件事：断在哪、因此哪个比较不可比。
 */
function GapWarning({ buckets }: { buckets: readonly WindowBucket[] }) {
  const t = useT();
  const summary = useMemo(() => summarizeWindows(buckets), [buckets]);
  if (!summary || summary.gapCount === 0 || !summary.maxGapWindow) return null;
  const worst = summary.maxGapWindow;
  return (
    <div
      className="mb-3 rounded-md px-3 py-2 text-[11px] leading-relaxed"
      style={{
        background: 'rgb(var(--zh-danger) / 0.07)',
        border: '1px solid rgb(var(--zh-danger) / 0.25)',
        color: 'rgb(var(--zh-text))',
      }}
    >
      {t('page.reports.window.gapWarn', {
        defaultValue: '有 {{gapTotal}} 段数据断档，最长 {{days}} 天（断到 {{at}}）。',
        gapTotal: summary.gapCount,
        days: summary.maxGapDays ?? 0,
        at: worst.key,
      })}{' '}
      {worst.deltaSpanDays !== null && (
        <span className="text-zh-muted">
          {t('page.reports.window.gapImplication', {
            defaultValue:
              '断档前后的「较上期」变化跨了 {{span}} 天，不能当作一个周期的趋势来读。',
            span: worst.deltaSpanDays,
          })}
        </span>
      )}
    </div>
  );
}

/** 维度变化：只显示真正变化的维度，未检测维度不当成 0 分 */
function DimensionDeltaChips({ bucket }: { bucket: WindowBucket }) {
  const t = useT();
  const changed = bucket.dimensions.filter((d) => d.status !== 'not-run' && d.delta !== 0);
  if (changed.length === 0) {
    return <span className="text-[11px] text-zh-muted">{t('page.reports.window.noChange', { defaultValue: '无变化' })}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {changed.slice(0, 4).map((dim) => (
        <span
          key={dim.name}
          className="inline-flex items-baseline gap-1 text-[11px] px-1.5 py-0.5 rounded bg-zh-panel"
        >
          <span className="text-zh-muted">{dimensionName(dim.name, t)}</span>
          <span className="font-bold" style={{ color: deltaColor(dim.delta) }}>
            {formatDelta(dim.delta)}
          </span>
        </span>
      ))}
      {changed.length > 4 && (
        <span className="text-[11px] text-zh-muted">+{changed.length - 4}</span>
      )}
    </div>
  );
}

function WindowRow({ bucket }: { bucket: WindowBucket }) {
  const t = useT();
  return (
    <tr
      className="border-b border-zh-line last:border-0"
      // 缺口行整行淡红底：让「这一行的数字跨了断档」在扫视时就能被看见
      style={bucket.isGap ? { background: 'rgb(var(--zh-danger) / 0.05)' } : undefined}
    >
      <td className="px-4 py-2.5 font-mono text-xs text-zh-text">
        {bucket.label}
        {bucket.isGap && bucket.gapDays !== null && (
          <div className="text-[10px] font-sans font-bold" style={{ color: 'rgb(var(--zh-danger))' }}>
            {t('page.reports.window.gapBadge', {
              defaultValue: '断档 {{days}} 天',
              days: bucket.gapDays,
            })}
          </div>
        )}
      </td>
      <td className="px-4 py-2.5 text-xs text-zh-muted">{bucket.scans}</td>
      <td className="px-4 py-2.5">
        <span className="font-bold text-sm" style={{ color: getScoreColor(bucket.endScore) }}>
          {bucket.endScore}
        </span>
      </td>
      <td className="px-4 py-2.5 text-xs font-bold" style={{ color: deltaColor(bucket.delta) }}>
        {formatDelta(bucket.delta)}
      </td>
      <td className="px-4 py-2.5 text-xs font-bold">
        <span style={{ color: deltaColor(bucket.deltaVsPrevWindow ?? 0) }}>
          {formatDelta(bucket.deltaVsPrevWindow)}
        </span>
        {/* 缺口时「较上期」不再是「一个周期」的比较，必须标出真实跨度 */}
        {bucket.isGap && bucket.deltaSpanDays !== null && (
          <div className="text-[10px] font-normal text-zh-muted">
            {t('page.reports.window.spanBadge', {
              defaultValue: '跨 {{days}} 天',
              days: bucket.deltaSpanDays,
            })}
          </div>
        )}
      </td>
      <td className="px-4 py-2.5 text-[11px] text-zh-muted font-mono">
        {bucket.minScore === bucket.maxScore
          ? String(bucket.minScore)
          : `${bucket.minScore} ~ ${bucket.maxScore}`}
      </td>
      <td className="px-4 py-2.5">
        <DimensionDeltaChips bucket={bucket} />
      </td>
    </tr>
  );
}

/** 窗口明细表：表头与行渲染独立成组件，主区块保持浅层 JSX */
function WindowTableHead() {
  const t = useT();
  return (
    <thead>
      <tr className="bg-zh-panel">
        <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
          {t('page.reports.window.col.period', { defaultValue: '时间窗' })}
        </th>
        <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
          {t('page.reports.window.col.scans', { defaultValue: '检查' })}
        </th>
        <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
          {t('page.reports.window.col.endScore', { defaultValue: '期末分' })}
        </th>
        <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
          {t('page.reports.window.col.delta', { defaultValue: '期内变化' })}
        </th>
        <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
          {t('page.reports.window.col.vsPrev', { defaultValue: '较上期' })}
        </th>
        <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
          {t('page.reports.window.col.range', { defaultValue: '波动区间' })}
        </th>
        <th className="text-left px-4 py-2.5 font-medium text-zh-muted text-xs">
          {t('page.reports.window.col.dimensions', { defaultValue: '维度变化' })}
        </th>
      </tr>
    </thead>
  );
}

function WindowTable({ buckets }: { buckets: readonly WindowBucket[] }) {
  return (
    <ResultCard variant="list" className="overflow-hidden">
      <table className="w-full text-sm">
        <WindowTableHead />
        <tbody>
          {buckets.toReversed().map((bucket) => (
            <WindowRow key={bucket.key} bucket={bucket} />
          ))}
        </tbody>
      </table>
    </ResultCard>
  );
}

export function ReportWindowSection({ data }: { data: HealthScoreData[] }) {
  const t = useT();
  const [granularity, setGranularity] = useState<WindowGranularity>('day');
  const buckets = useMemo(() => buildWindowBuckets(data, granularity), [data, granularity]);

  if (data.length === 0) return null;

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-zh-text">
          {t('page.reports.window.title', { defaultValue: '趋势分析' })}
        </h2>
        <GranularityTabs value={granularity} onChange={setGranularity} />
      </div>
      <WindowSummary buckets={buckets} />
      <GapWarning buckets={buckets} />
      <WindowTable buckets={buckets} />
      <p className="mt-2 text-[11px] text-zh-muted">
        {t('page.reports.window.note', {
          defaultValue:
            '期末分 = 该时间窗内最后一次检查；期内变化 = 窗内首末之差；较上期 = 与上一窗期末比较。两者口径不同，不可混看。',
        })}
      </p>
      <p className="mt-1 text-[11px] text-zh-muted">
        {t('page.reports.window.gapNote', {
          defaultValue:
            '覆盖率 = 有检查记录的窗口 ÷ 该跨度应有窗口；最大空档 = 相邻两次检查之间最长的间隔。覆盖率满格也可能存在空档（例如月报只有 3 个月，但 9 月到 10 月间空了 41 天），所以两个指标要一起看。',
        })}
      </p>
      {/*
        归因放在窗口区块内部而不是 ReportsPage：粒度状态在这里，
        放外面就会出现「窗口表按周、归因按日」的口径错位。
      */}
      <AttributionSection data={data} buckets={buckets} />
    </div>
  );
}
