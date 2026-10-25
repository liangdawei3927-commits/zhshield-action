/**
 * 侧边栏交互组件的对外门面（保持既有导入路径不变）。
 *
 * 实现已按职责拆分：
 * - `sidebar-projects.tsx`：项目列表 / 项目行操作 / 添加项目
 * - `sidebar-sections.tsx`：标题栏 / AI 工具开关 / 规则进化入口
 *
 * 本文件只做再导出：新增侧边栏能力请放进上面两个文件（或各自的新模块），
 * 不要在此堆实现 —— 它的职责就是"唯一对外的门面"。
 */

export { ProjectsSection } from './sidebar-projects';
export type { ProjectInfo } from './sidebar-projects';
export { SidebarHeader, AiToolSection, EvolveSection } from './sidebar-sections';
