import { t } from '@zh/i18n';
import type { ScoreDimension } from '@zh/shared';
import { navItems, type NavGroup } from '../components/layout/nav-items';
import { dimensionName } from './reports-logic';
import { domainScoreView, type DomainScoreView } from './domain-score-logic';

/**
 * 报告中心「分类评分」一行卡的视图模型（纯函数）。
 *
 * 设计约束（三条，都是踩过的坑）：
 *
 * 1. **顺序必须等于导航顺序**。卡片行的存在意义是「十张卡 = 导航栏十个分类」，
 *    用户拿它当导航用的。`HealthScoreData.dimensions` 的顺序是评分器
 *    `DIMENSION_CATEGORIES` 的声明顺序（quality/gate/security/dependencies/…），
 *    与导航顺序（inspect/guard/sentinel/…）不同；直接 map dimensions 会让每张卡的
 *    位置和导航栏错位，用户点「第三个」进去的是另一个分类。
 *
 * 2. **映射只有一份**，源在 `navItems[].scoreDimension`。报告页不维护旁表。
 *
 * 3. **分数字典只有一套**。复用 `domainScoreView`（分类页顶部评分条同款），
 *    保证卡片上的分与点进去之后看到的分是同一套口径、同一套文案；
 *    这里只做「取哪一维」，不做任何二次计算。
 */
export interface CategoryScoreCardView {
  /** 点击跳转目标（导航分类 id） */
  navId: string;
  /** 该分类对应的评分维度 */
  dimension: ScoreDimension;
  /**
   * 所属性质分组（来自导航定义）。卡片行据此在组间留缝，
   * 让「按需检查」与「常驻守护」两类分在视觉上分开。
   */
  group: NavGroup;
  /** 卡片标题：与顶部导航同名（看到的 = 点进去的） */
  title: string;
  /** 分数 / 等级 / 颜色 / 数据状态（与分类页评分条同源） */
  view: DomainScoreView;
  /** hover 提示：分类名 · 维度名 · 权重 */
  hint: string;
}

/** 一维的展示用最小结构（HealthScoreData.dimensions 的子集，便于测试构造） */
export interface DimensionEntry {
  name: string;
  score: number;
  weight?: number;
  status?: 'scored' | 'not-run';
  /**
   * 该维自己的数据时间（域快照 / 门禁报告落盘时间）。
   *
   * 十维各自独立跑、各自独立落盘，一个「汇总时间」代表不了十个域：
   * 用统一时间戳会让「3 天前扫过的域」和「刚扫过的域」显示成同一新鲜度。
   * 分类页本来就是按每维自己的时间判陈旧（`pickDomainScore` → `domainScoreView`），
   * 卡片要与分类页同口径就必须也按维取时间；缺省时回退汇总时间。
   */
  generatedAt?: string | null;
}

export interface CategoryScoreCardsParams {
  /** 汇总记录的维度数组（可缺维：老记录只有已跑过的域） */
  dimensions: readonly DimensionEntry[];
  /** 汇总时间戳（用于判定「陈旧」） */
  generatedAt: string;
  /** 当前时间（便于测试注入） */
  now?: number;
  /** 翻译函数（默认 @zh/i18n 的 t） */
  tr?: typeof t;
}

/**
 * 由导航定义 + 汇总维度生成卡片视图。
 *
 * 缺维（老记录没跑过该域）与 not-run（跑了但该域未运行）都会被渲染成
 * 「—」+ 状态文案，绝不显示 0 —— 见 dimension-view.test.ts 的同一口径。
 */
export function categoryScoreCards({
  dimensions,
  generatedAt,
  now,
  tr = t,
}: CategoryScoreCardsParams): CategoryScoreCardView[] {
  // flatMap 而非 filter+map：既避免非空断言，又保持「顺序 = navItems 顺序」这一字面事实
  return navItems.flatMap((item) => {
    const dimension = item.scoreDimension;
    if (dimension === null) return [];
    const dim = dimensions.find((d) => d.name === dimension);
    const view = domainScoreView({ dim, generatedAt: dim?.generatedAt ?? generatedAt, now, tr });
    const title = item.label ?? tr(item.labelKey);
    return [
      {
        navId: item.id,
        dimension,
        group: item.group,
        title,
        view,
        hint: cardHint(title, dimension, dim?.weight, view, tr),
      },
    ];
  });
}

/** hover 提示：分类名 · 维度名 · 权重（可选）；陈旧时补一句数据时间 */
function cardHint(
  title: string,
  dimension: ScoreDimension,
  weight: number | undefined,
  view: DomainScoreView,
  tr: typeof t,
): string {
  const parts = [title, dimensionName(dimension, tr)];
  if (typeof weight === 'number' && weight > 0) {
    parts.push(`${Math.round(weight * 100)}%`);
  }
  if (view.kind === 'stale') {
    parts.push(tr('page.reports.dataStale', { hours: view.ageHours }));
  }
  return parts.join(' · ');
}

/**
 * 由「实时总览」构造卡片行入参（纯函数，便于单测）。
 *
 * 数据时间取**参与域里最旧的那一个**，不是最新的、也不是读取时刻：
 * 总分是十域加权出来的，它的可信度取决于最旧那一维 —— 用最新时间会把
 * 「3 天前扫过的域」掩盖成新鲜数据，这与陈旧提示「把旧分当当前状态」要防的是同一件事。
 * 没有任何域带时间锚点时，回退本次读取时刻。
 */
export function overviewRowInput(overview: {
  overall: number;
  dimensions: readonly DimensionEntry[];
  redLine?: { capped: boolean; cap: number; reasons: Array<{ kind: string; count: number }> };
  readAt: string;
}): {
  dimensions: readonly DimensionEntry[];
  generatedAt: string;
  overall: {
    score: number;
    partial: { run: number; total: number };
    redLine?: { capped: boolean; cap: number; reasons: Array<{ kind: string; count: number }> };
  };
} {
  const scored = overview.dimensions.filter((d) => d.status !== 'not-run');
  const times = scored
    .map((d) => (d.generatedAt ? Date.parse(d.generatedAt) : Number.NaN))
    .filter((ms) => !Number.isNaN(ms));
  return {
    dimensions: overview.dimensions,
    generatedAt: times.length > 0 ? new Date(Math.min(...times)).toISOString() : overview.readAt,
    overall: {
      score: overview.overall,
      partial: { run: scored.length, total: overview.dimensions.length },
      ...(overview.redLine ? { redLine: overview.redLine } : {}),
    },
  };
}

/** 反查某维度对应的导航分类（用于「从这里跳过去」的反向校验与测试） */
export function navIdForDimension(dimension: ScoreDimension): string | undefined {
  return navItems.find((item) => item.scoreDimension === dimension)?.id;
}
