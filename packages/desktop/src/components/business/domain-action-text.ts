/**
 * 各域主操作按钮的「运行态文案」唯一来源。
 *
 * 背景（2026-10-25 用户反馈）：健康环下面的那个大按钮（一键体检 / 立即扫描 / 开始盘点…）
 * 与各分类详情页顶部的同名按钮本该是同一个按钮，实际是两条路径：
 *   - 空态走 PageShell → 传静态词「巡检中...」；
 *   - 详情页走各页面手写 PrimaryButton → loadingLabel 接的是 useTaskRun 的 progressLabel，
 *     那是 `t('task.runningLabel')` 拼出来的「体检中... 42% · 正在检查 src/a.ts」。
 * 同一个动作两套文案，且详情页那套把百分比和任务消息全塞进按钮里 —— 按钮只剩
 * 两行高，长消息被截断成半截乱码，用户读不出"现在在干什么"。
 *
 * 约定（本文件是唯一开关）：
 * 1. 按钮运行态只允许状态词（「体检中… / 扫描中… / 盘点中… / 检查中…」）；
 * 2. 百分比与任务消息归进度条（DomainScanProgress 的 progress + label），不进按钮；
 * 3. 任何页面不得自行拼串 —— 加域就在下表加一行，不要就地写 t('...扫中')。
 */

/** 按钮运行态文案键（域 + 非域动作） */
export const ACTION_RUNNING_LABEL_KEY = {
  inspect: 'page.inspect.scanning',
  guard: 'page.guard.scanning',
  garbage: 'page.garbage.scanning',
  security: 'page.security.checking',
  deps: 'page.deps.checking',
  techdebt: 'page.techdebt.checking',
  performance: 'page.performance.detecting',
  refactor: 'page.refactor.scanning',
  sentinel: 'page.sentinel.refreshing',
  /**
   * 哨兵「监控中」—— 与上面的「刷新中」是同一域的两种运行态：
   * 刷新是一次性动作，监控是长驻状态（开启后一直跑，按钮必须能停）。
   * 分列两项而不是复用一个键，是因为按钮上写什么直接决定用户以为在停什么。
   */
  sentinelMonitor: 'page.sentinel.monitoring',
  backup: 'page.backup.backingUp',
  /** 报告中心「汇总生成报告」 */
  reports: 'page.reports.generating',
  /** 演进引擎「架构分析」 */
  evolve: 'page.evolve.analyzing',
  /** 只读快照页「重新检查」 */
  snapshot: 'page.snapshotReport.rescanning',
  /** 欢迎页「添加项目」等无进度动作（不进入 loading，仅占位保持类型完整） */
  project: 'common.loading',
} as const;

/**
 * 动作归属键 = {@link ACTION_RUNNING_LABEL_KEY} 的键集合。
 * 各页面用它向按钮/空态声明「我这一域」，文案由本模块统一收口，不允许页面自带 loading 文案。
 */
export type ActionRunningKey = keyof typeof ACTION_RUNNING_LABEL_KEY;

/** 状态词与任务消息的分隔符（` · ` / ` • `）；提到模块级复用，避免每次调用重新编译正则 */
const STATUS_HEAD_SEPARATOR_RE = /[·•]/;

/**
 * 归一化：把任何来源的文案削成「纯状态词」。
 *
 * 这不是为了容错，是为了把约定变成硬约束 —— 万一有人再把
 * `progressLabel`（含百分比 + 任务消息）接回按钮，也只会在按钮上留下「体检中...」，
 * 而不是把整条任务消息糊在按钮里。真阳性示例见 __tests__/domain-action-label.test.ts。
 */
export function toPureStatusLabel(raw: string | undefined | null): string {
  if (!raw) return '';
  // 任务消息以「 · 」拼在状态词后（见 task-store 的 task.runningLabel）
  const head = raw.split(STATUS_HEAD_SEPARATOR_RE)[0] ?? '';
  return head
    .replace(/\d+(?:[.,]\d+)?\s*%/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
