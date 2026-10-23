/**
 * 分数变化归因：把「总分变了 N 分」拆到具体维度。
 *
 * ## 为什么必须有这一层
 *
 * 报告中心原本只有一条总分曲线：「2026-08 期末 100.0 → 2026-10 期末 90.3，
 * 区间总变化 -9.7」。这个数字**对用户没有行动价值** —— 它不告诉用户该去修哪个域。
 * 用户看到 -9.7 的第一反应必然是「哪几个域掉的」，而这个答案在聚合后的总分里已经消失。
 *
 * 归因要回答的就是这一句：**-9.7 分里，各域各占多少。**
 *
 * ## 口径必须与真实评分算法严格一致
 *
 * 总分不是简单平均，而是（见 `@zh/scoring` 的 `computeOverall`）：
 *
 * ```
 * overall = Σ(score_i × weight_i) / Σ(weight_i)     // 仅对 status !== 'not-run' 的域
 * overall = min(overall, redLineCap)                // 有 critical 事实时一票压制
 * ```
 *
 * 两个细节决定了归因能不能信：
 *
 * 1. **not-run 维度不参与加权 ⇒ 分母会变。** 10 个域里只跑了 9 个时，每个域的有效权重
 *    不是 10% 而是 1/9 ≈ 11.1%。所以「某域分数掉了 10 分」值多少总分，取决于当时有几个域在跑。
 *    归因必须按**归一化后的有效权重**算，不能拿配置里的 0.1 直接乘。
 * 2. **红线封顶与域分无关。** 封顶生效/解除会让总分跳变，但那不是任何域变好或变差。
 *    硬把它摊进某个域就是编造。
 *
 * ## 三项分解 + 恒等式（本模块的核心约束）
 *
 * ```
 * 实际变化 = Σ 域贡献 + 结构项 + 封顶项
 * ```
 *
 * - **域贡献** = (本期域分 − 上期域分) × 有效权重（按上期口径归一化）
 * - **结构项** = 未封顶总分变化 − Σ 域贡献。它吸收的是「口径本身变了」：
 *   某个域从 not-run 变成已检测（或反之）、权重被画像调整、参与域数量变化。
 *   这一项**不摊给任何具体域** —— 摊了就变成编造；UI 只如实标注它由什么引起。
 * - **封顶项** = 本期封顶效应 − 上期封顶效应。
 *
 * 三项相加必须**精确等于**实际变化（`reconciled`）。这条恒等式是这个模块唯一
 * 能自证没在胡说的东西：拆完之后合不回去，说明公式本身有洞，不许上线。
 *
 * ## 不做的事
 *
 * - 跨 `scoreVersion` 不归因（不同版本的维度集与扣分口径都变了，相减无意义）；
 * - 权重缺失/非正数不臆造默认值，直接返回不可用（`missing-weight`）；
 * - 只有一端参与（进出参与集）的域不产生贡献 —— 它的影响走结构项，不硬算。
 */

import type { HealthScoreData } from '../types/electron';

type Dimension = HealthScoreData['dimensions'][number];
type DimensionStatus = 'scored' | 'not-run';

/**
 * 对账容差（分）。
 *
 * 记录里的域分保留 1 位小数，而记录的总分是用**未舍入**的域分算出来的；
 * 归因必须用记录里的域分重算，两者之间天然存在差异，最坏约 0.05（10 域 × 0.05 × 0.1）。
 * 取 0.1 留一倍余量。超过这个数就是公式错了，不是精度问题。
 */
export const RECONCILE_EPSILON = 0.1;

/** 一次比较的两端（总是可得，即使归因不可用） */
export interface ScorePair {
  /** 上期记录时间 */
  startAt: string;
  /** 本期记录时间 */
  endAt: string;
  startScore: number;
  endScore: number;
  /** 实际总变化 = endScore − startScore（用的是记录里的总分，可能已封顶） */
  actualDelta: number;
  /**
   * 同一差值的 2 位小数版本（对账专用）。
   *
   * `actualDelta` 保留 1 位是为了和窗口表的「较上期」逐字一致；但各分项是 2 位，
   * 对账时拿 1 位去比就会出现「+11.29 + (-2.64) = 8.65，实际 8.7」这种看起来很假的场面。
   * 对账条统一用这个值，两边才对得齐。
   */
  exactDelta: number;
}

/** 单个维度对总分变化的贡献 */
export interface AttributionDomain {
  name: string;
  startScore: number;
  endScore: number;
  /** 域内变化 = endScore − startScore */
  delta: number;
  /** 配置权重（来自记录，未归一化；通常 0.1） */
  weight: number;
  /**
   * 有效权重 = weight ÷ 上期参与集权重和。
   *
   * 这是「该域每变化 1 分值多少总分」。参与域越少，它越大 —— 直接解释了
   * 「为什么只跑了 9 个域时，掉分看起来更厉害」。
   */
  effectiveWeight: number;
  /** 对总分变化的贡献（分，保留 2 位） */
  points: number;
}

/** 归因不可用的原因（必须让用户看到具体原因，不能静默显示 0） */
export type AttributionUnavailable =
  /** 两次记录跨评分算法版本，维度集与扣分口径都变了，相减无意义 */
  | 'version-mismatch'
  /** 两次记录的维度集不同（不是 not-run，而是根本没有这一维），无法对齐 */
  | 'dimension-set-mismatch'
  /** 记录的维度缺 weight，无法算贡献 —— 不臆造默认权重 */
  | 'missing-weight'
  /** 至少一端没有任何已检测维度，无法加权 */
  | 'no-active-dimension';

export interface AttributionBreakdown extends ScorePair {
  ok: true;
  /** 两端都已检测的维度，按 |points| 降序 */
  domains: AttributionDomain[];
  /** Σ 域贡献 */
  domainsPoints: number;
  /** 结构项：口径变化（参与集/权重/归一化分母），不摊给具体域 */
  structurePoints: number;
  /** 封顶项：本期封顶效应 − 上期封顶效应 */
  capPoints: number;
  /** 恒等式残差，应 ≈ 0 */
  residual: number;
  /** 三项相加是否精确还原实际变化 */
  reconciled: boolean;
  /** 两端未封顶的加权总分（用于让人看清封顶吃掉了多少） */
  rawStartScore: number;
  rawEndScore: number;
  /** 两端参与加权的域数 */
  activeStart: number;
  activeEnd: number;
  /** 本期新进入参与集的域（结构项的可观测原因） */
  entered: string[];
  /** 本期退出参与集的域（结构项的可观测原因） */
  exited: string[];
  /** 两端权重不一致的域（画像变化会改权重，也是结构项的原因） */
  weightChanged: string[];
  /** 是否发生过红线封顶（任一端） */
  capped: boolean;
}

export type AttributionResult =
  | AttributionBreakdown
  | ({ ok: false; reason: AttributionUnavailable } & ScorePair);

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 缺字段一律按「已检测」处理，与上游 `status?` 缺省语义一致 */
function statusOf(dim: Dimension | undefined): DimensionStatus | null {
  if (!dim) return null;
  return dim.status === 'not-run' ? 'not-run' : 'scored';
}

function isPositiveWeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function emptyPair(start: HealthScoreData, end: HealthScoreData): ScorePair {
  return {
    startAt: start.timestamp,
    endAt: end.timestamp,
    startScore: start.score,
    endScore: end.score,
    actualDelta: round1(end.score - start.score),
    exactDelta: round2(end.score - start.score),
  };
}

/**
 * 把「上期记录 → 本期记录」的总分变化拆到各维度。
 *
 * 两端必须是真实的评分记录（`HealthScoreData`，来自 scores 历史），
 * 不能是现场重算的临时对象 —— 否则归因的是「现在算出来的分」而不是「当时记下的分」。
 */
export function attributeScoreDelta(
  start: HealthScoreData,
  end: HealthScoreData,
): AttributionResult {
  const pair = emptyPair(start, end);

  if (
    typeof start.scoreVersion === 'number' &&
    typeof end.scoreVersion === 'number' &&
    start.scoreVersion !== end.scoreVersion
  ) {
    return { ok: false, reason: 'version-mismatch', ...pair };
  }

  const startActive = start.dimensions.filter((d) => d.status !== 'not-run');
  const endActive = end.dimensions.filter((d) => d.status !== 'not-run');
  if (startActive.length === 0 || endActive.length === 0) {
    return { ok: false, reason: 'no-active-dimension', ...pair };
  }

  // 维度集必须一致。`not-run` 的域仍留在 dimensions 里（score 0 + status），所以
  // 「集合不同」只代表两次记录的维度构成真的变了 —— 这时任何一项分解都无从对齐，
  // 结构项会变成一个巨大的、解释不清的数字，比不给归因更误导。
  const startNames = new Set(start.dimensions.map((d) => d.name));
  const endNames = new Set(end.dimensions.map((d) => d.name));
  if (
    startNames.size !== endNames.size ||
    [...startNames].some((name) => !endNames.has(name))
  ) {
    return { ok: false, reason: 'dimension-set-mismatch', ...pair };
  }

  // 只有参与加权的域需要权重；not-run 域的 weight 不进入任何分母
  const weightOk =
    startActive.every((d) => isPositiveWeight(d.weight)) &&
    endActive.every((d) => isPositiveWeight(d.weight));
  if (!weightOk) {
    return { ok: false, reason: 'missing-weight', ...pair };
  }

  const startMap = new Map(start.dimensions.map((d) => [d.name, d]));
  const endMap = new Map(end.dimensions.map((d) => [d.name, d]));
  /** 域名取并集，保持「本期顺序优先」以便 UI 稳定 */
  const names: string[] = end.dimensions.map((d) => d.name);
  for (const dim of start.dimensions) {
    if (!endMap.has(dim.name)) names.push(dim.name);
  }

  const startWeightSum = startActive.reduce((sum, d) => sum + d.weight, 0);
  const endWeightSum = endActive.reduce((sum, d) => sum + d.weight, 0);

  const rawStartScore =
    startActive.reduce((sum, d) => sum + d.score * d.weight, 0) / startWeightSum;
  const rawEndScore = endActive.reduce((sum, d) => sum + d.score * d.weight, 0) / endWeightSum;

  const domains: AttributionDomain[] = [];
  const entered: string[] = [];
  const exited: string[] = [];
  const weightChanged: string[] = [];
  /**
   * 域贡献的**未舍入**总和，专供对账用。
   *
   * 不能拿 `domains` 里的 `delta`（已 round1）再乘权重：每域最多引入 0.05 × 权重 的误差，
   * 10 域累加会逼近 0.1 的容差边缘，让「数据坏了」和「舍入」混在一起分不清。
   */
  let domainsRaw = 0;

  for (const name of names) {
    const before = startMap.get(name);
    const after = endMap.get(name);
    const beforeStatus = statusOf(before);
    const afterStatus = statusOf(after);

    if (beforeStatus === 'scored' && afterStatus === 'scored' && before && after) {
      // 归一化口径统一按**上期**：归因描述的是「从上期走到本期」这个过程，
      // 起点的分母决定「每 1 分域内变化值多少总分」。权重若在本期变化（画像调整），
      // 差额不去掰扯归属，全部由结构项精确吸收。
      const effectiveWeight = before.weight / startWeightSum;
      const delta = after.score - before.score;
      domainsRaw += delta * effectiveWeight;
      domains.push({
        name,
        startScore: round1(before.score),
        endScore: round1(after.score),
        delta: round1(delta),
        weight: before.weight,
        effectiveWeight,
        points: round2(delta * effectiveWeight),
      });
      if (Math.abs(before.weight - after.weight) > 1e-9) weightChanged.push(name);
    } else if (afterStatus === 'scored') {
      entered.push(name);
    } else if (beforeStatus === 'scored') {
      exited.push(name);
    }
  }

  domains.sort((a, b) => Math.abs(b.points) - Math.abs(a.points) || a.name.localeCompare(b.name));

  const rawDelta = rawEndScore - rawStartScore;
  const structurePoints = rawDelta - domainsRaw;

  /**
   * 封顶项只在**记录自己声明了 `redLine.capped`** 时才计算。
   *
   * 这里绝不能写成 `end.score - rawEndScore`（"总分比按域分算出来的低 ⇒ 一定是封顶"）——
   * 那等于给任何「总分与域分不符」都发一张免罪符：数据坏了、写分点了错，
   * 全都会被显示成「红线压制」，而且恒等式照样闭合、照样打绿勾。
   * 没声明封顶的差额留在 residual 里，让 `reconciled` 变红 —— 这是本模块唯一能自证的方式。
   */
  const capStartEffect = start.redLine?.capped === true ? start.score - rawStartScore : 0;
  const capEndEffect = end.redLine?.capped === true ? end.score - rawEndScore : 0;
  const capPoints = capEndEffect - capStartEffect;

  // 用精确差值而非 1 位小数的 actualDelta 对账，避免把显示精度当成公式误差
  const residual = end.score - start.score - (domainsRaw + structurePoints + capPoints);

  return {
    ok: true,
    ...pair,
    domains,
    domainsPoints: round2(domainsRaw),
    structurePoints: round2(structurePoints),
    capPoints: round2(capPoints),
    residual: round2(residual),
    reconciled: Math.abs(residual) <= RECONCILE_EPSILON,
    rawStartScore: round1(rawStartScore),
    rawEndScore: round1(rawEndScore),
    activeStart: startActive.length,
    activeEnd: endActive.length,
    entered,
    exited,
    weightChanged,
    capped: Boolean(start.redLine?.capped || end.redLine?.capped),
  };
}

/** 时间戳 → 记录索引（报告中心的 data 与窗口共用同一批记录，按 timestamp 对齐） */
export function indexRecordsByTimestamp(
  data: readonly HealthScoreData[],
): Map<string, HealthScoreData> {
  const map = new Map<string, HealthScoreData>();
  for (const item of data) map.set(item.timestamp, item);
  return map;
}

/**
 * 某窗口「较上期」的归因：本窗口末次记录 vs 上一窗口末次记录。
 *
 * 与 `WindowBucket.deltaVsPrevWindow` 严格同源（同一对时间戳），
 * 保证表里的「较上期」和归因区块拆的是同一个差值。
 *
 * 无上一窗口 / 记录缺失 → null（不编造）。
 */
export function attributeWindowVsPrev(
  buckets: readonly {
    key: string;
    endAt: string;
  }[],
  index: number,
  byTimestamp: ReadonlyMap<string, HealthScoreData>,
): AttributionResult | null {
  if (index <= 0 || index >= buckets.length) return null;
  const start = byTimestamp.get(buckets[index - 1].endAt);
  const end = byTimestamp.get(buckets[index].endAt);
  if (!start || !end) return null;
  return attributeScoreDelta(start, end);
}

/**
 * 区间归因：首窗口期末 → 末窗口期末。
 *
 * 与 `summarizeWindows().totalDelta` 严格同源 —— 那个「区间总变化 -9.7」被质疑时，
 * 这里必须能拆出构成它的每一项，否则两个数字对不上就成了新的不可信来源。
 */
export function attributeRange(
  buckets: readonly {
    endAt: string;
  }[],
  byTimestamp: ReadonlyMap<string, HealthScoreData>,
): AttributionResult | null {
  if (buckets.length < 2) return null;
  const start = byTimestamp.get(buckets[0].endAt);
  const end = byTimestamp.get(buckets[buckets.length - 1].endAt);
  if (!start || !end) return null;
  return attributeScoreDelta(start, end);
}

/**
 * 贡献占比（用于横条宽度）：|points| ÷ Σ|points|。
 *
 * 不除以 `actualDelta`：实际变化接近 0 时（甚至为 0）除法会爆炸或除零，
 * 而「谁占已归因部分的多少」本身就有意义，且永远稳定。
 */
export function contributionShare(points: number, totalAbsolute: number): number {
  if (!Number.isFinite(points) || totalAbsolute <= 0) return 0;
  return Math.min(1, Math.abs(points) / totalAbsolute);
}

/** 所有维度贡献的绝对值之和（占比分母） */
export function totalAbsolutePoints(domains: readonly AttributionDomain[]): number {
  return domains.reduce((sum, d) => sum + Math.abs(d.points), 0);
}

/**
 * 本次变化是否**主要由口径变化造成**（而不是任何域真的变好/变差）。
 *
 * 为什么必须单独判一次：真实数据里这不是边缘情况。实测外层项目 16 条记录，
 * `83.8 → 89.98（+6.2）`那一次 **6.18 全部来自结构项** —— 没有任何一个域的分数变化，
 * 只是参与加权的域从 5 个变成 10 个，归一化分母变了，平均分就被抬上去。
 *
 * 如果 UI 不点明，用户会把这个 +6.2 当成「改进成果」写进汇报；而那其实只是
 * 「这次多跑了几个域」。归因的价值在于揭穿这种假涨跌，而不只是列几个数字。
 *
 * 判据取 |结构项| ≥ 一半的 |实际变化|，且变化本身不小于 0.5 分（太小的变化不值得警示）。
 */
export function isStructureDominated(result: AttributionBreakdown): boolean {
  const delta = Math.abs(result.actualDelta);
  if (delta < 0.5) return false;
  return Math.abs(result.structurePoints) >= delta / 2;
}
