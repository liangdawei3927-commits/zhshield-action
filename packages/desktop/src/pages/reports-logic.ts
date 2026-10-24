import { useCallback, useEffect, useState } from 'react';
import { t } from '@zh/i18n';
import {
  getProfile,
  getScore,
  getScoreHistory,
  generateReportSummary,
} from '../services/engineApi';
import { useToast } from '../components/ui/Toast';
import { collectModuleScores, type ModuleScoreView } from './module-scores-logic';
import type { HealthScoreData } from '../types/electron';
import { getScoreColor } from '../components/business/score-grade';
import { useLoadingAction } from '../hooks/useLoadingAction';

/** 预别名类型 — 避免 .tsx 中出现泛型尖括号（会被 JSX 深度检测误判） */
export type HealthScoreRow = Readonly<HealthScoreData>;

// 分数→等级色为跨页面共享逻辑（评分环 / 报告表格 / 演化页……），
// 实现已提取到 components/business/score-grade；此处保持原有 named export 对外契约不变。
export { getScoreColor };

export function getScoreLabel(score: number, tr: typeof t = t) {
  if (score >= 90) return tr('page.reports.scoreLabel.excellent');
  if (score >= 75) return tr('page.reports.scoreLabel.good');
  if (score >= 60) return tr('page.reports.scoreLabel.needsImprovement');
  return tr('page.reports.scoreLabel.danger');
}

/**
 * 涨跌配色：健康分涨=好（绿），跌=差（红），与评分卡同一语义。
 *
 * 放在本文件而不是 report-window-parts：趋势表与分数归因两个区块都要用它，
 * 而两者互相引用（窗口区块挂归因区块）—— 任一侧持有实现都会形成循环依赖。
 * 本文件是两者共同的下游，故由它承载。
 */
export function deltaColor(delta: number): string {
  if (delta > 0) return 'rgb(var(--zh-success))';
  if (delta < 0) return 'rgb(var(--zh-danger))';
  return 'rgb(var(--zh-muted))';
}

/** 带符号的变化值；null 显示破折号（不是 0 —— 0 会被读成「没变化」） */
export function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  if (delta > 0) return `+${delta}`;
  return `${delta}`;
}

/** 未检测维度的中性色（该域从未运行：既不是好也不是坏，不参与总分加权） */
const NOT_RUN_COLOR = 'rgb(var(--zh-muted))';

/** 单个评分维度的展示视图：区分「未检测」与「0 分」 */
export interface DimensionView {
  /** true = 该域从未运行（不参与总分加权） */
  notRun: boolean;
  /** 展示用颜色 */
  color: string;
  /** 展示用状态文案 */
  label: string;
  /** 展示用分值文本；未检测时为占位符而非 0 */
  scoreText: string;
}

/**
 * 维度展示视图：把「未检测」与「0 分」分开。
 *
 * `@zh/scoring` 的 `buildHealthDimensions` 为未运行的域产出 `{ score: 0, status: 'not-run' }`
 * 并**保留在 dimensions 数组里**（只是不参与 overall 加权）。渲染层若直接按 score 上色，
 * 未检测的域会显示成「0 分 · 危险」—— 把"没查"报成"查了、很差"。
 *
 * 缺省视作已检测（与 `@zh/scoring` 的 `DimensionScore.status?` 语义一致，兼容旧记录）。
 */
export function dimensionView(
  dim: { score: number; status?: 'scored' | 'not-run' },
  tr: typeof t = t,
): DimensionView {
  if (dim.status === 'not-run') {
    return {
      notRun: true,
      color: NOT_RUN_COLOR,
      label: tr('page.reports.scoreLabel.notRun'),
      scoreText: '—',
    };
  }
  return {
    notRun: false,
    color: getScoreColor(dim.score),
    label: getScoreLabel(dim.score, tr),
    scoreText: String(dim.score),
  };
}

/** 已检测维度数：总分只由这些维度加权而来，未检测维度被排除在外 */
export function countRunDimensions(
  dims: readonly { status?: 'scored' | 'not-run' }[],
): number {
  return dims.filter((d) => d.status !== 'not-run').length;
}

export function dimensionName(dimKey: string, tr: typeof t = t): string {
  const key = `page.reports.dimension.${dimKey}`;
  const name = tr(key);
  return name === key ? dimKey : name;
}

export function gradeLabel(grade: string, tr: typeof t = t): string {
  const key = `page.reports.grade.${grade}`;
  const label = tr(key);
  return label === key ? grade : label;
}

/**
 * 总分新鲜度阈值（24h）—— 全仓**唯一**的新鲜度阈值。
 *
 * 历史上主进程还有一份 `DASHBOARD_FRESH_MS`（服务仪表盘六卡 not-run/scored/expired），
 * 两者靠 `src/__tests__/freshness-parity.test.ts` 的结构断言保持数值一致。六卡链路
 * 因渲染层零消费于 2026-09-19 整体删除后，主进程侧不再需要该阈值，这里成为唯一来源；
 * 上述用例随之改为「单一来源 + 禁止主进程再引入第二份」。
 *
 * 总分是**对上一次检查结果的汇总**，不是实时值 —— 报告中心只读各域最近一次
 * 落盘结果（guard 报告记录 + `.zhshield/diagnostics/domains/<source>.json` +
 * `dashboard-state.json`），不会为了出分而重跑任何检查。因此必须把「这份分有多旧」
 * 显式告诉用户，否则陈旧分会被当成当前状态（T14 落分口径统一）。
 */
export const SCORE_FRESH_MS = 24 * 60 * 60 * 1000;

/** 总分数据新鲜度：是否已过期 + 距今小时数 */
export interface ScoreFreshness {
  /** true = 数据超过阈值，总分只能代表「截至那一时刻」的状态 */
  stale: boolean;
  /** 距今天数取整（小时）；时间戳不可解析时为 0 并同样判 stale */
  ageHours: number;
}

/** 计算总分的数据新鲜度（纯函数，便于单测；不依赖 React / Electron） */
export function scoreFreshness(timestamp: string, now: number = Date.now()): ScoreFreshness {
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return { stale: true, ageHours: 0 };
  const ageMs = Math.max(0, now - ts);
  return { stale: ageMs > SCORE_FRESH_MS, ageHours: Math.floor(ageMs / 3_600_000) };
}

/**
 * 把评分历史规整为「旧 → 新」。
 *
 * 报告中心所有读法都建立在这个顺序上：`data.at(-1)` 是「最新总分」，
 * `HistoryTable` 靠 `toReversed()` 翻成最新在上，窗口聚合按相邻两条算涨跌，
 * sparkline 按数组顺序画线。顺序一旦反了，**不是排列不同，而是内容全错** ——
 * 2026-10-24 实测过：主进程历史查询按 `created_at DESC` 返回，页面把项目史上第一条
 * 记录（2026-08-29、98.6 分、5 个维度）当成「当前状态」展示了很久。
 *
 * 顺序的第一责任方是 SQL（`getScoreHistory` 已改为内层取最新 N 条、外层升序）。
 * 这里再排一次是渲染边界守卫：跨 IPC/HTTP 边界后顺序无法靠类型保证，而显示错误的
 * 代价远高于一次 O(n log n) 排序。`sort` 是稳定排序，同时间戳（同秒落分）保持原序。
 */
export function toChronological<T extends { timestamp: string }>(rows: readonly T[]): T[] {
  // toSorted 不改入参（等价于 [...rows].sort），调用方可能直接持有 IPC 返回的数组
  return rows.toSorted((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    // 时间戳不可解析时保持原位置（返回 0），避免把坏数据甩到数组两端改变「最新」语义
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  });
}

/** 历史分数数据加载：数据状态 + 拉取 */
function useScoreHistoryData(projectPath: string): {
  data: HealthScoreData[];
  fetchHistory: () => Promise<void>;
} {
  const [data, setData] = useState<HealthScoreData[]>([]);
  const fetchHistory = useCallback(async () => {
    setData(toChronological(await getScoreHistory(projectPath)));
  }, [projectPath]);
  return { data, fetchHistory };
}

/** 报告页历史分数加载：加载状态 + 自动加载 */
function useScoreHistory(projectPath: string): {
  data: HealthScoreData[];
  loading: boolean;
  load: () => Promise<void>;
} {
  const { data, fetchHistory } = useScoreHistoryData(projectPath);
  const [loading, setLoading] = useState(true);
  const load = useLoadingAction(fetchHistory, setLoading);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, load };
}

/**
 * 报告页全部状态与副作用：历史加载、汇总生成报告。
 *
 * 「汇总生成报告」= 只读汇总，不是「跑一遍检查」：
 * 读各域（guard/inspect/…）最新落盘结果 → 统一维度加权 → 落库一条新评分。
 * 触发权属于各治理域自己（在各自页面点扫描）；报告中心只负责把已有结果汇总成总分，
 * 因此点按钮不会再在任务中心冒出 guard/inspect 任务。
 * 各域都没跑过时后端返回 null —— 明确提示用户「先运行检查」，
 * 而不是写一条 0 分污染历史（未检测 ≠ 0 分）。
 */
export function useReportsPage(projectPath: string) {
  const { data, loading, load } = useScoreHistory(projectPath);
  const { toast } = useToast();

  const handleNewReport = useCallback(async () => {
    const summary = await generateReportSummary(projectPath);
    if (!summary) {
      toast(t('page.reports.noResults'), 'warning');
      return;
    }
    await load();
    toast(t('page.reports.summaryDone', { score: Math.round(summary.score) }), 'success');
  }, [projectPath, load, toast]);

  return { data, loading, handleNewReport };
}

/** 报告页模块级评分：拉取项目画像子模块 + 各模块评分，汇集为视图；无子模块时返回空 */
export function useModuleScores(projectPath: string) {
  const [modules, setModules] = useState<ModuleScoreView[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const profile = await getProfile(projectPath);
      if (cancelled || !profile?.modules?.length) {
        if (!cancelled) setModules([]);
        setLoading(false);
        return;
      }
      const views = await collectModuleScores(profile.modules, getScore);
      if (!cancelled) setModules(views);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);
  return { modules, loading };
}
