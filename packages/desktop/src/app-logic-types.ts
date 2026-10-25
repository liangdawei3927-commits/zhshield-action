/**
 * `app-logic` 的共享类型与常量（拆分后各子模块的公共依赖）。
 *
 * 从 `app-logic.ts` 拆出：三个子模块（开关 / 项目 / 应用状态）都要用这些定义，
 * 单独成模块可避免它们之间互相引用形成环。
 */

import type { AiToolConfigData } from './types/electron';

/** 应用页面路由标识：欢迎页 + 各治理域页面 + 报告/备份/画像等汇总页 */
export type Page =
  | 'welcome'
  | 'security'
  | 'deps'
  | 'techdebt'
  | 'secrets'
  | 'garbage'
  | 'performance'
  | 'guard'
  | 'inspect'
  | 'sentinel'
  | 'refactor'
  | 'evolve'
  | 'reports'
  | 'backup'
  | 'profile';

/** 已添加项目的基本信息：展示名 + 绝对路径 */
export interface ProjectInfo {
  name: string;
  path: string;
}

export const STORAGE_KEY = 'zh:projects';
export const ONBOARDED_KEY = 'zh:onboarded-projects';

export const DEFAULT_AI_TOOL: AiToolConfigData = {
  id: 'opencode',
  name: 'OpenCode',
  enabled: false,
  mode: 'linter',
  configFile: '.opencode/command/zhshield.md',
};
