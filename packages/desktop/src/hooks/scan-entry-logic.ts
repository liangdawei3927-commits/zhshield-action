/**
 * 扫描结束后的「要不要自动进入详情页」判据（纯函数，零 React 依赖，可单测）。
 *
 * 产品口径（2026-10-25 用户明确要求）：
 * - 主页上的主按钮（一键体检 / 立即扫描 / 一键扫描 / 马上检查 / 开始扫描 …）
 *   只负责**跑一次检查**，不负责**换页**。跑完停在分类主页，用户自己点右上角
 *   「查看详情」才进详情。
 * - 唯一的例外：**该域不满分**。这时用户需要知道"具体哪里出了问题"，
 *   自动展开详情省掉一次点击；满分（100）则没有任何东西要看，不该打断。
 *
 * 为什么把判据抽成纯函数：这条规则会同时作用于 8 个分类页，
 * 若各页各写一份 `if (score < 100)`，任何口径调整都要改八处且必然漏改。
 */

/** 域满分。分数由 @zh/scoring 产出并被 `toDimensionScore` 钳在 [0, 100]。 */
export const DOMAIN_FULL_SCORE = 100;

/**
 * 判据输入：只取「有没有分」与「多少分」，不绑定具体 IPC 类型。
 *
 * 结构对齐 `DomainScoreData`（`engine:getDomainScore` 的返回），
 * 但刻意放宽为可选字段 —— 该 IPC 在 HTTP 模式、旧快照、异常时都可能返回 null 或缺字段，
 * 判据必须能自己兜住这些形态，而不是让调用方各写一套 `?.`。
 */
export interface DomainScoreSignal {
  /** 0-100；非有限数视同没有分 */
  score?: number | null;
  /** `scored` = 该域真的出了分；`not-run` = 该域没跑过/没参与计分 */
  status?: string | null;
}

/**
 * 扫描结束后是否自动进入详情页。
 *
 * 三档，缺一不可：
 * 1. **满分（≥100）** → 不进详情。这正是用户要的：没有问题就别换页。
 * 2. **不满分（<100）** → 进详情，直接看"哪里出了问题"。
 * 3. **判断不了**（没有信号 / 未检测 / 非有限数）→ **进详情**。
 *    这一档是安全默认值：判定不了满分就老老实实展示结果，
 *    宁可多给一次详情，也不要把可能存在的问题藏在主页后面。
 *    它也保证了这个改动**最坏情况不比改动前更差** —— 拿不到分时退回旧行为。
 */
export function shouldAutoEnterDetail(signal: DomainScoreSignal | null | undefined): boolean {
  if (!signal || signal.status !== 'scored') return true;
  const score = signal.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) return true;
  return score < DOMAIN_FULL_SCORE;
}

/** 一次扫描的前后状态：是否在跑 + 当时手里的报告 */
export interface ScanWatch {
  /** 任务中心视角的「正在跑/排队中」 */
  loading: boolean;
  /** 本域实时报告（扫描完成后是新对象；无结果为 null） */
  report: unknown;
}

/** 扫描状态迁移的结论 */
export type ScanTransition = 'none' | 'finished';

/**
 * 识别「一次扫描刚刚跑完，并且产出了新结果」。
 *
 * 为什么不能只看「报告非空」：分类页挂载时会把**上次落盘的报告**读回内存
 * （`useSavedDomainReport` / 门禁的 `listGuardReports`），于是「报告非空」
 * 在页面刚打开时就已经成立。按它判会自动跳详情 —— 正是本改动要根治的行为。
 *
 * 为什么不能只看 loading 的上升沿/下降沿：用户点「停止」时任务同样从 running 变
 * 结束，但**报告没有变**（保留旧结果，不清空）。那不是一次有结论的扫描，
 * 不该据此把用户推进详情。故判据是三者同时成立：
 * 上一刻在跑 + 这一刻停了 + 手里的报告换了一份新的。
 */
export function scanTransition(prev: ScanWatch, next: ScanWatch): ScanTransition {
  if (!prev.loading || next.loading) return 'none';
  // 失败/取消后清空报告：没有任何新结论可看
  if (next.report === null || next.report === undefined) return 'none';
  // 报告是同一个对象引用 = 没换过（停止/失败保留旧报告）→ 不是新结论
  if (next.report === prev.report) return 'none';
  return 'finished';
}
