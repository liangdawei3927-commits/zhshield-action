import type { GovernanceDomain, ActionType } from './sop-types';
import type { ProjectFeature } from './sop-types';
import type { ToolResult } from '@zh/shared';

/**
 * ToolScanOutcome — M1b 工具扫描去重的共享结果。
 * Promise 永不 reject：扫描失败也是一种结果（所有消费者得到等价错误评估）。
 */
export type ToolScanOutcome = { ok: true; result: ToolResult } | { ok: false; error: string };

/**
 * ToolScanCache — 单次 evaluateRules 调用内的工具扫描缓存（M1b 去重）。
 * 键 = `${toolId}|${规范化 config 的稳定序列化}`；值 = single-flight 的 in-flight Promise
 * （并发 worker 命中同键时共享同一次真实扫描）。
 * 运行时对象、非序列化数据；仅 runner.evaluateAll 创建，调用结束即弃，不跨调用共享。
 */
export type ToolScanCache = Map<string, Promise<ToolScanOutcome>>;

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

  /** 多域筛选（可选）。设置时按该集合过滤（如巡检含安全域 inspect+security）；
   *  优先于单值 {@link domain}。 */
  domains?: GovernanceDomain[];

  /** 动作类型筛选（可选，仅评估该 action 的规则） */
  action?: ActionType;

  /** 是否干运行（不实际执行阻断） */
  dryRun?: boolean;

  /** 项目画像特征（可选）。存在时按画像裁剪规则集（security 域恒包含），实现按项目精准评估 */
  projectFeature?: ProjectFeature;

  /** 附加参数（透传到适配器） */
  extra?: Record<string, unknown>;

  /** M1b 工具扫描缓存（可选）。仅 runner.evaluateAll 创建并注入；缺省时工具扫描不去重（保持旧行为） */
  toolScanCache?: ToolScanCache;
}
