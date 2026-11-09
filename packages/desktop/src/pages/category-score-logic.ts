import { t } from '@zh/i18n';
import { isReferenceDimension, type ScoreDimension } from '@zh/shared';
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
  /** hover 提示：分类名 · 维度名 · 有效权重 · 满分贡献 */
  hint: string;
  /** true = 参考维度（techdebt）：有分但不计总分，卡上标「参考」 */
  reference: boolean;
  /** 该分类在总分里的满分（有效权重 × 100）；参考维度为 null */
  maxContribution: number | null;
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
  /** 有效权重（weight / Σ参与总分权重）；缺省时回退 weight */
  effectiveWeight?: number;
  /** 对总分的贡献 = score × effectiveWeight */
  contribution?: number;
  /** true = 参考维度（techdebt），不计总分 */
  excludedFromOverall?: boolean;
}

/** 分类评分卡入参：维度数组 + 汇总时间 + 总分输入 */
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
    // 参考维度（techdebt）不计总分：卡片标「参考」，不显示「满分 X 分」
    const reference = dim?.excludedFromOverall === true || isReferenceDimension(dimension);
    const effectiveWeight = reference ? 0 : (dim?.effectiveWeight ?? dim?.weight ?? 0);
    return [
      {
        navId: item.id,
        dimension,
        group: item.group,
        title,
        view,
        reference,
        maxContribution: reference || effectiveWeight <= 0 ? null : effectiveWeight * 100,
        hint: cardHint({ title, dimension, weight: effectiveWeight, view, reference, tr }),
      },
    ];
  });
}

/** hover 提示入参：一维卡片的展示要素（除 `weight` 外全部必填，故不用可选链吞缺） */
interface CardHintParams {
  /** 分类名（与导航同名） */
  title: string;
  /** 评分维度 */
  dimension: ScoreDimension;
  /** 有效权重；参考/未参与汇总时为 0（不拼百分比） */
  weight: number;
  /** 该维分数视图（陈旧时补数据时间） */
  view: DomainScoreView;
  /** true = 参考维度（不计总分） */
  reference: boolean;
  /** 翻译函数 */
  tr: typeof t;
}

/**
 * hover 提示：分类名 · 维度名 · 有效权重/满分 · 参考标记；陈旧时补数据时间。
 *
 * 用**有效权重**而不是配置里的 `weight`：全 9 类检测时每类实际是 11.1%，
 * 拿 0.1 去乘会少算约 11%，用户按 10% 核对贡献永远对不上。
 */
function cardHint({ title, dimension, weight, view, reference, tr }: CardHintParams): string {
  const parts = [title, dimensionName(dimension, tr)];
  if (reference) {
    parts.push(tr('page.reports.categoryScore.referenceOnly'));
  } else if (weight > 0) {
    parts.push(tr('page.reports.categoryScore.maxContribution', { points: (weight * 100).toFixed(1) }));
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
/** 总分卡入参（报告中心与分类卡共用；techdebt 参考维度不在分母里） */
export interface OverallScoreInput {
  score: number;
  /** 只统计计分维度：技术债是参考指标，不在分母里 */
  partial: { run: number; total: number };
  /** true = 计分维度全部检测；false 时总分只是「已检测部分均分」 */
  complete: boolean;
  /** 最弱计分类（用于总分卡常驻短板提示）；无计分类时为 undefined */
  weakest?: { name: ScoreDimension; score: number };
  redLine?: { capped: boolean; cap: number; reasons: Array<{ kind: string; count: number }> };
}

export function overviewRowInput(overview: {
  overall: number;
  dimensions: readonly DimensionEntry[];
  redLine?: { capped: boolean; cap: number; reasons: Array<{ kind: string; count: number }> };
  readAt: string;
}): {
  dimensions: readonly DimensionEntry[];
  generatedAt: string;
  overall: OverallScoreInput;
} {
  // 分母只算计分维度：参考维度（techdebt）检测了也不进总分/覆盖度
  const scored = overview.dimensions.filter(
    (d) => !isReferenceDimension(d.name) && d.excludedFromOverall !== true,
  );
  const run = scored.filter((d) => d.status !== 'not-run');
  const times = run
    .map((d) => (d.generatedAt ? Date.parse(d.generatedAt) : Number.NaN))
    .filter((ms) => !Number.isNaN(ms));
  const weakest =
    run.length > 0
      ? run.reduce((min, d) => (d.score < min.score ? d : min), run[0]!)
      : undefined;
  return {
    dimensions: overview.dimensions,
    generatedAt: times.length > 0 ? new Date(Math.min(...times)).toISOString() : overview.readAt,
    overall: {
      score: overview.overall,
      partial: { run: run.length, total: scored.length },
      complete: run.length === scored.length && scored.length > 0,
      ...(weakest ? { weakest: { name: weakest.name as ScoreDimension, score: weakest.score } } : {}),
      ...(overview.redLine ? { redLine: overview.redLine } : {}),
    },
  };
}

/** 反查某维度对应的导航分类（用于「从这里跳过去」的反向校验与测试） */
export function navIdForDimension(dimension: ScoreDimension): string | undefined {
  return navItems.find((item) => item.scoreDimension === dimension)?.id;
}
