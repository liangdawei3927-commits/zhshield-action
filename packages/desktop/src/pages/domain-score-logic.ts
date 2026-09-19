import { t } from '@zh/i18n';
import { dimensionView, scoreFreshness } from './reports-logic';

/** 参与总分的 10 个评分维度（与 @zh/scoring 的 DIMENSION_CATEGORIES 键一致，十域评分体系 v2） */
export type ScoreDimension =
  | 'quality'
  | 'gate'
  | 'security'
  | 'dependencies'
  | 'techdebt'
  | 'refactor'
  | 'performance'
  | 'sentinel'
  | 'garbage'
  | 'backup';

/**
 * 分类页「本域评分」卡的展示视图（纯函数，供 DomainScoreCard 消费）。
 *
 * 数据源是报告中心最近一次汇总的 HealthScoreData（getScore）——**只读不算**：
 * 各维分数由 @zh/scoring 在汇总时统一产出，页面不做任何二次计算，
 * 避免出现与总分口径不一致的第三套算法（09-19 批 6 教训）。
 */
export interface DomainScoreView {
  /** no-data 尚未汇总过 / not-run 该域未运行 / scored 新鲜 / stale 超过 24h */
  kind: 'no-data' | 'not-run' | 'scored' | 'stale';
  /** 展示分值文本；无数据或未检测时为 '—'（绝不显示 0） */
  scoreText: string;
  /** 展示颜色 */
  color: string;
  /** 等级 / 状态文案 */
  label: string;
  /** 数据距今小时数（仅 scored/stale 有意义） */
  ageHours: number;
  /** 上一轮检查的分数（实时快照携带对比基线时才有；用于「上次 → 本次」行） */
  previousScore?: number;
}

const MUTED = 'rgb(var(--zh-muted))';

/**
 * 由汇总数据中该维度的值构建展示视图。
 * @param dim 该维度在 dimensions 数组中的条目（undefined = 汇总数据里没有这一维）
 * @param generatedAt 汇总时间戳（undefined = 无汇总数据）
 */
export function domainScoreView(
  dim: { score: number; status?: 'scored' | 'not-run' } | undefined,
  generatedAt: string | undefined,
  now: number = Date.now(),
  tr: typeof t = t,
  previousScore?: number,
): DomainScoreView {
  if (!dim) {
    return {
      kind: 'no-data',
      scoreText: '—',
      color: MUTED,
      label: tr('page.domainScore.noData'),
      ageHours: 0,
    };
  }
  const v = dimensionView(dim, tr);
  if (v.notRun) {
    return {
      kind: 'not-run',
      scoreText: v.scoreText,
      color: v.color,
      label: v.label,
      ageHours: 0,
    };
  }
  const f = scoreFreshness(generatedAt ?? '', now);
  return {
    kind: f.stale ? 'stale' : 'scored',
    scoreText: v.scoreText,
    color: v.color,
    label: v.label,
    ageHours: f.ageHours,
    ...(typeof previousScore === 'number' ? { previousScore } : {}),
  };
}

/** 从汇总数据中取出指定维度的条目（找不到返回 undefined，交由 domainScoreView 兜底） */
export function findDimension(
  data: { dimensions: Array<{ name: string; score: number; status?: 'scored' | 'not-run' }> } | null,
  dimension: ScoreDimension,
): { score: number; status?: 'scored' | 'not-run' } | undefined {
  return data?.dimensions.find((d) => d.name === dimension);
}

/** 实时评分：引擎在检查落盘时写进按域快照的 dimensionScore（engine:getDomainScore 返回值） */
export interface LiveScore {
  score: number;
  issues?: number;
  status: 'scored' | 'not-run';
  /** 快照生成时间（ISO 8601，即本次检查完成时间） */
  generatedAt: string;
  /** 上一轮检查的分数（快照覆盖写前抢救出的对比基线；旧格式快照无此字段） */
  previousScore?: { score: number; generatedAt: string };
}

/** pickDomainScore 的返回：喂给 domainScoreView 的维度条目 + 数据时间 */
export interface PickedScore {
  dim: { score: number; status?: 'scored' | 'not-run' } | undefined;
  generatedAt: string | undefined;
  /** 上一轮分数（仅 live 来源携带；汇总数据无轮次对比基线） */
  previousScore?: number;
}

/**
 * 选择评分数据源：实时快照优先，回退报告中心汇总。
 *
 * - live 存在且已评分 → 用 live（本次检查跑完当场出分，时间戳即检查完成时间）；
 * - live 缺失或为旧格式快照（无评分字段）→ 回退汇总数据对应维度；
 * - 两者皆无 → dim 为 undefined（domainScoreView 兜底 no-data）。
 *
 * 注意这是**选源**而非算分：两个数据源的分数都由 @zh/scoring 统一产出。
 */
export function pickDomainScore(
  live: LiveScore | null,
  summary: {
    dimensions: Array<{ name: string; score: number; status?: 'scored' | 'not-run' }>;
    timestamp?: string;
  } | null,
  dimension: ScoreDimension,
): PickedScore {
  if (live && live.status === 'scored') {
    return {
      dim: { score: live.score, status: live.status },
      generatedAt: live.generatedAt,
      ...(typeof live.previousScore?.score === 'number'
        ? { previousScore: live.previousScore.score }
        : {}),
    };
  }
  return { dim: findDimension(summary, dimension), generatedAt: summary?.timestamp };
}
