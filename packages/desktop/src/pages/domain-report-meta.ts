/**
 * 分类域的**元数据登记表**（domain-report-meta.ts）
 *
 * ## 为什么有这层
 *
 * 九个分类详情页此前各自在 JSX 里写死四项域元数据：
 *
 * ```tsx
 * <ReportShell
 *   dimension="dependencies"   // 读哪一维的健康分
 *   historyDomain="deps"       // 读哪一域的历史记录
 *   navId="deps"               // 顶行图标
 *   actionDomain="deps"        // 主按钮的运行态文案
 * />
 * ```
 *
 * 这四项是**域的固有属性**，不是页面的选择 —— 却散落在九个文件里，且彼此并不相等：
 * `inspect` 域的评分维度是 `quality`、历史域是 `inspect`；`deps` 域的评分维度是
 * `dependencies`、历史域是 `deps`。这种「同名不同值」正是最容易出错的地方：
 * 把 inspect 的 dimension 抄成 'inspect'，页面会静默显示不出评分。
 *
 * 本表把它们收成一行一域，页面只声明「我是哪个域」。新增一个分类页 = 加一行。
 *
 * ## 与既有登记表的分工
 *
 *   · `task-store.ts` 的 `DOMAIN_TASK_KIND` —— 域 → 任务类型（跑什么任务）
 *   · 本表 `DOMAIN_REPORT_META`     —— 域 → 评分维度/历史域/图标（显示什么）
 *
 * 两者都是「域 → 稳定映射」这一类事实，刻意分开：前者管执行、后者管展示，
 * 改一个不影响另一个。
 */
import type { ScoreDimension } from '@zh/shared';
import type { ActionRunningKey } from '../components/business/domain-action-text';

/**
 * 有详情页的分类域。
 *
 * 取值与 `ActionRunningKey` 的同名子集一致 —— 主按钮的运行态文案默认就取域键，
 * 因此绝大多数页面不需要额外声明 `actionDomain`。
 */
export type ReportDomainKey =
  | 'inspect'
  | 'guard'
  | 'garbage'
  | 'security'
  | 'deps'
  | 'techdebt'
  | 'performance'
  | 'refactor'
  | 'sentinel'
  | 'backup';

/** 域详情页元数据：读哪一维的健康分 + 历史面板用哪个域键（两者可不相等，见下表） */
export interface DomainReportMeta {
  /** 评分维度（读哪一维的健康分） */
  dimension: ScoreDimension;
  /** 历史记录域键；不传则该域不渲染历史面板 */
  historyDomain?: string;
}

/**
 * 域 → 详情页元数据（唯一事实源）。
 *
 * ⚠️ `inspect` 的评分维度是 `quality` 而非 `inspect`：体检分记在质量维度下。
 * `deps` 同理 —— 评分维度 `dependencies`、历史域 `deps`。这两个「不等」的映射
 * 只在本表出现一次，页面照抄会写错。
 */
export const DOMAIN_REPORT_META: Record<ReportDomainKey, DomainReportMeta> = {
  inspect: { dimension: 'quality', historyDomain: 'inspect' },
  guard: { dimension: 'gate', historyDomain: 'guard' },
  garbage: { dimension: 'garbage', historyDomain: 'garbage' },
  security: { dimension: 'security', historyDomain: 'security' },
  deps: { dimension: 'dependencies', historyDomain: 'deps' },
  techdebt: { dimension: 'techdebt', historyDomain: 'techdebt' },
  performance: { dimension: 'performance', historyDomain: 'performance' },
  refactor: { dimension: 'refactor', historyDomain: 'refactor' },
  sentinel: { dimension: 'sentinel' },
  backup: { dimension: 'backup' },
};

/**
 * 主按钮的运行态文案默认取域键；只有哨兵需要覆盖（监控中 vs 刷新中）
 */
export function defaultActionDomain(domain: ReportDomainKey): ActionRunningKey {
  // backup 不是扫描域（没有任务中心通道），其空态按钮用通用文案
  return domain === 'backup' ? 'backup' : domain;
}
