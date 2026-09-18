import { t } from '@zh/i18n';
import { dimensionView, scoreFreshness } from './reports-logic';

/** 参与总分的 7 个评分维度（与 @zh/scoring 的 DIMENSION_CATEGORIES 键一致） */
export type ScoreDimension =
  | 'quality'
  | 'gate'
  | 'security'
  | 'dependencies'
  | 'techdebt'
  | 'refactor'
  | 'performance';

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
  };
}

/** 从汇总数据中取出指定维度的条目（找不到返回 undefined，交由 domainScoreView 兜底） */
export function findDimension(
  data: { dimensions: Array<{ name: string; score: number; status?: 'scored' | 'not-run' }> } | null,
  dimension: ScoreDimension,
): { score: number; status?: 'scored' | 'not-run' } | undefined {
  return data?.dimensions.find((d) => d.name === dimension);
}
