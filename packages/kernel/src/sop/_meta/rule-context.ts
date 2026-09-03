import type { GovernanceDomain, ActionType } from './sop-types';
import type { ProjectFeature } from './sop-types';

/**
 * RuleContext — 规则评估的上下文
 *
 * 描述即将被规则引擎评估的环境状态：
 * - 目标仓库/文件
 * - 调用方指定的 domain/action 过滤
 * - 额外控制参数
 */
export interface RuleContext {
  /** 项目根目录 */
  repoRoot: string;

  /** 目标文件列表（可选，为空时扫描整个项目） */
  files?: string[];

  /** 治理域筛选（可选，仅评估该 domain 的规则） */
  domain?: GovernanceDomain;

  /** 动作类型筛选（可选，仅评估该 action 的规则） */
  action?: ActionType;

  /** 是否干运行（不实际执行阻断） */
  dryRun?: boolean;

  /** 项目画像特征（可选）。存在时按画像裁剪规则集（security 域恒包含），实现按项目精准评估 */
  projectFeature?: ProjectFeature;

  /** 附加参数（透传到适配器） */
  extra?: Record<string, unknown>;
}
