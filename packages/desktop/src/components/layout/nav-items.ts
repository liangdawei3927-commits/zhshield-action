import type { TaskKind } from '../../types/electron';

/**
 * 分类的扫描进度来源 —— 导航分类与任务中心任务类型的唯一映射。
 *
 * owner 语义：
 * - own：本分类的扫描任务就是该 kind，进度即本域真实进度；
 * - borrowed：借用他域任务（未注册独立 kind），进度条显示的不是本域进度，待收口。
 *
 * 缺省 scanProgress = 该分类没有统一进度条（无任务源，或用自建进度条）。
 */
export interface NavScanProgress {
  /** 进度条订阅的任务中心任务类型 */
  taskKind: TaskKind;
  owner: 'own' | 'borrowed';
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
 *
 * 独立成模块（而非内联在 TopNav 组件里）的两个原因：
 *   1) 组件文件带 React/图标依赖，测试想断言导航结构就得整棵加载；
 *   2) 导航顺序本身就是产品约定，应当被测试直接锁定。
 */
export interface NavItem {
  id: string;
  labelKey: string;
  /** 直接显示文本（优先于 t(labelKey)，用于 i18n 尚未收录的新页面） */
  label?: string;
  /** 统一扫描进度来源；缺省 = 该分类无统一进度条 */
  scanProgress?: NavScanProgress;
}

export const navItems: NavItem[] = [
  { id: 'inspect', labelKey: 'nav.inspect', scanProgress: { taskKind: 'pipeline', owner: 'own' } },
  { id: 'guard', labelKey: 'nav.guard', scanProgress: { taskKind: 'guard', owner: 'own' } },
  { id: 'sentinel', labelKey: 'nav.sentinel' },
  {
    id: 'security',
    labelKey: 'nav.security',
    scanProgress: { taskKind: 'security', owner: 'own' },
  },
  { id: 'deps', labelKey: 'nav.deps', scanProgress: { taskKind: 'pipeline', owner: 'borrowed' } },
  { id: 'garbage', labelKey: 'nav.garbage', scanProgress: { taskKind: 'garbage', owner: 'own' } },
  {
    id: 'performance',
    labelKey: 'nav.performance',
    scanProgress: { taskKind: 'performance', owner: 'own' },
  },
  {
    id: 'techdebt',
    labelKey: 'nav.techdebt',
    scanProgress: { taskKind: 'pipeline', owner: 'borrowed' },
  },
  {
    id: 'refactor',
    labelKey: 'nav.refactor',
    scanProgress: { taskKind: 'refactor', owner: 'own' },
  },
  { id: 'backup', labelKey: 'nav.backup' },
];

/** 查某分类的扫描进度来源（无则 undefined） */
export function navScanProgress(id: string): NavScanProgress | undefined {
  return navItems.find((item) => item.id === id)?.scanProgress;
}
