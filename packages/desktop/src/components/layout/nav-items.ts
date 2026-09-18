/**
 * 顶部导航分类项 —— 顺序即职责声明（2026-09-18 导航各司其职改造 T9/T11）。
 *
 * - 首位「项目体检」（inspect）= 全站唯一发起源码检查的入口。该名号原由聚合仪表盘
 *   （dashboard）占用，但 dashboard 页跑的是「8 域串行全检 + 六卡汇总」，既不是体检
 *   也不该由页面发起扫描 —— 该页与全检通道已删除，名号归还给真正做检查的 inspect 域。
 * - 末位「报告中心」（reports）= 只读汇总各域最新结果，不发起任何检查。
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
}

export const navItems: NavItem[] = [
  { id: 'inspect', labelKey: 'nav.inspect' },
  { id: 'guard', labelKey: 'nav.guard' },
  { id: 'sentinel', labelKey: 'nav.sentinel' },
  { id: 'security', labelKey: 'nav.security' },
  { id: 'deps', labelKey: 'nav.deps' },
  { id: 'garbage', labelKey: 'nav.garbage' },
  { id: 'performance', labelKey: 'nav.performance' },
  { id: 'techdebt', labelKey: 'nav.techdebt' },
  { id: 'refactor', labelKey: 'nav.refactor' },
  { id: 'reports', labelKey: 'nav.reports' },
];
