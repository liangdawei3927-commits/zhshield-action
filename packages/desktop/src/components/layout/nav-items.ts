import type { HealthScoreDimension } from '@zh/shared';
import type { TaskKind } from '../../types/electron';

/**
 * 分类的扫描进度来源 —— 导航分类与任务中心任务类型的唯一映射。
 *
 * taskKind 必须是本分类**自己**的任务类型。借用他域任务会让进度条显示非本域进度，
 * 故不提供「借用」标记：没有独立任务源的分类（哨兵长驻监控 / 备份自有进度总线）
 * 直接缺省 scanProgress。
 *
 * 缺省 scanProgress = 该分类没有统一进度条（无任务源，或用自建进度条）。
 */
export interface NavScanProgress {
  /** 进度条订阅的任务中心任务类型 */
  taskKind: TaskKind;
}

/**
 * 顶部导航分类项 —— 顺序即职责声明（2026-09-18 导航各司其职改造 T9/T11）。
 *
 * - 首位「项目体检」（inspect）= 全站唯一发起源码检查的入口。该名号原由聚合仪表盘
 *   （dashboard）占用，但 dashboard 页跑的是「8 域串行全检 + 六卡汇总」，既不是体检
 *   也不该由页面发起扫描 —— 该页与全检通道已删除，名号归还给真正做检查的 inspect 域。
 * - 末位「备份中心」（backup）= 独立治理域，触发权与判定权域内独占。
 *   原末位「报告中心」（reports）改为只读汇总各域最新结果、不发起任何检查，
 *   入口收敛：报告中心入口在侧边栏项目行；分类页右上角为查看详情（仅有结果时显示）。
 * - 中间 8 项各是独立治理域，触发权与判定权域内独占，互不借调。
 * - **两段式**：前段 `onDemand`（按需检查 8 项）、后段 `daemon`（常驻守护：哨兵、备份）。
 *   哨兵与备份没有"扫一次"的语义（前者开启后长驻监听、后者定时执行），
 *   曾与扫描项平铺混排而看不出区别，现由 `group` 显式声明并分段渲染。
 *
 * 独立成模块（而非内联在 TopNav 组件里）的两个原因：
 *   1) 组件文件带 React/图标依赖，测试想断言导航结构就得整棵加载；
 *   2) 导航顺序本身就是产品约定，应当被测试直接锁定。
 */
/**
 * 分类性质分组 —— 决定导航里的排序与视觉分段。
 *
 * - `onDemand` 按需检查：用户点一下、跑一次、出一份结论（体检/门禁/安全/…）。
 *   这类分类各有一条统一扫描进度条（见 `scanProgress`）。
 * - `daemon` 常驻守护：开启后自己跑、结果随时间累积（哨兵长驻监听 / 备份定时任务）。
 *   这类没有"扫一次"的语义，页面动作是「开启监控 / 刷新 / 立即备份」。
 *
 * 为什么是显式声明而不是从 `scanProgress` 推导：两者相关但不等价 ——
 * 备份有自建进度总线（将来可能也登记 taskKind），但性质上仍是常驻守护。
 * 推导会让"加进度条"这个动作悄悄改变分组，声明则强迫新增分类时明确表态。
 */
export type NavGroup = 'onDemand' | 'daemon';

/** 分组在导航里的先后顺序（按需检查在前：首屏第一动作应是「体检」而不是「开启监控」） */
export const NAV_GROUP_ORDER: readonly NavGroup[] = ['onDemand', 'daemon'];

export interface NavItem {
  id: string;
  labelKey: string;
  /** 直接显示文本（优先于 t(labelKey)，用于 i18n 尚未收录的新页面） */
  label?: string;
  /** 统一扫描进度来源；缺省 = 该分类无统一进度条 */
  scanProgress?: NavScanProgress;
  /**
   * 本分类的性质分组（必填）。
   *
   * 导航与报告中心「评分总览」卡片行都按本字段分段渲染：同组必须连续，
   * 组间加分隔。不允许漏字段后静默混进「按需检查」段 —— 那正是哨兵曾经
   * 的处境（常驻监听被排在体检/门禁之后，看起来和一键扫描项是同一种东西）。
   */
  group: NavGroup;
  /**
   * 本分类在十域评分体系里对应的维度。
   *
   * 报告中心的「分类评分」一行卡由本字段派生：**顺序、卡片标题、点击跳转目标全部
   * 源自导航定义**，报告页不另维护第二份映射表 —— 两份表必然漂移（曾经 dimension
   * 数组顺序与导航顺序不同，同一批域按数组渲染出来就和导航栏对不上号）。
   *
   * 必填且允许 `null`：新增导航项时必须显式表态「参不参与评分」，不允许漏字段后
   * 静默从卡片行里消失。`null` 目前无实例，是给「只读汇总页放回导航」留的显式出口。
   */
  scoreDimension: HealthScoreDimension | null;
}

export const navItems: NavItem[] = [
  {
    id: 'inspect',
    labelKey: 'nav.inspect',
    group: 'onDemand',
    scanProgress: { taskKind: 'pipeline' },
    // quality 维由 inspect（质量巡检）产出：卡片叫「项目体检」才和点进去的页面对得上
    scoreDimension: 'quality',
  },
  {
    id: 'guard',
    labelKey: 'nav.guard',
    group: 'onDemand',
    scanProgress: { taskKind: 'guard' },
    scoreDimension: 'gate',
  },
  {
    id: 'security',
    labelKey: 'nav.security',
    group: 'onDemand',
    scanProgress: { taskKind: 'security' },
    scoreDimension: 'security',
  },
  {
    id: 'deps',
    labelKey: 'nav.deps',
    group: 'onDemand',
    scanProgress: { taskKind: 'deps' },
    scoreDimension: 'dependencies',
  },
  {
    id: 'garbage',
    labelKey: 'nav.garbage',
    group: 'onDemand',
    scanProgress: { taskKind: 'garbage' },
    scoreDimension: 'garbage',
  },
  {
    id: 'performance',
    labelKey: 'nav.performance',
    group: 'onDemand',
    scanProgress: { taskKind: 'performance' },
    scoreDimension: 'performance',
  },
  {
    id: 'techdebt',
    labelKey: 'nav.techdebt',
    group: 'onDemand',
    scanProgress: { taskKind: 'techdebt' },
    scoreDimension: 'techdebt',
  },
  {
    id: 'refactor',
    labelKey: 'nav.refactor',
    group: 'onDemand',
    scanProgress: { taskKind: 'refactor' },
    scoreDimension: 'refactor',
  },
  {
    id: 'sentinel',
    labelKey: 'nav.sentinel',
    group: 'daemon',
    scoreDimension: 'sentinel',
  },
  { id: 'backup', labelKey: 'nav.backup', group: 'daemon', scoreDimension: 'backup' },
];

/** 查某分类的扫描进度来源（无则 undefined） */
export function navScanProgress(id: string): NavScanProgress | undefined {
  return navItems.find((item) => item.id === id)?.scanProgress;
}

export interface NavGroupSegment {
  group: NavGroup;
  items: NavItem[];
}

/**
 * 按 `group` 把导航切成连续段（段边界 = group 变化处），供导航条与评分卡片行分段渲染。
 *
 * 不变量：**同组必须连续**。若某组被切成两段（如把哨兵挪回扫描项中间），
 * 段数就会大于组数 —— 导航测试用这一点锁住"不许再混排"。
 * 段内保持 navItems 的原顺序，不重排、不过滤。
 */
export function navGroupSegments(): NavGroupSegment[] {
  const segments: NavGroupSegment[] = [];
  for (const item of navItems) {
    const tail = segments.at(-1);
    if (tail && tail.group === item.group) tail.items.push(item);
    else segments.push({ group: item.group, items: [item] });
  }
  return segments;
}

/** 反查任务类型所属的导航分类（用于全局进度指示器点击跳转）；映射唯一，取首个命中 */
export function navIdForTaskKind(kind: TaskKind): string | undefined {
  return navItems.find((item) => item.scanProgress?.taskKind === kind)?.id;
}
