import type { ToolAdapter, AuditLogger } from '@zh/shared';
import type { EventBus } from '../bus';

/**
 * GuardEngine 的最小结构契约 — kernel 不反向依赖 @zh/guard，
 * 仅声明 dispatch-evaluators 实际读取的字段（run 返回值的 results[].status/message）。
 */
export interface GuardEngineLike {
  // opts 设为 unknown：GuardEngine.run 接受 CheckOptions（含字面量联合 CheckMode），
  // kernel 不反向依赖 @zh/guard，由调用方（dispatch-evaluators）负责构造。
  run(opts: unknown): Promise<{
    results?: Array<{ status?: string; message?: string }>;
  }>;
}

/**
 * InspectEngine 的最小结构契约 — kernel 不反向依赖 @zh/inspect，
 * 仅声明 dispatch-evaluators 实际读取的字段（runScan 返回值的 summary.total）。
 */
export interface InspectEngineLike {
  // scanType 实际为 'full' | 'incremental' | 'scheduled'，kernel 不感知，设为 unknown 兼容。
  // projectFeature 为 R3d 执行面投影激活的画像第三参（可选；缺省 → 不裁剪），结构契约随真实 runScan 对齐。
  runScan(
    projectId: string,
    scanType?: unknown,
    projectFeature?: unknown,
  ): Promise<{ summary?: { total?: number } }>;
}

/**
 * SecurityCheckEngine 的最小结构契约 — kernel 不反向依赖 @zh/security，
 * 仅声明 dispatch-evaluators 实际读取的字段（run 返回值的 results[].status/message）。
 *
 * 背景：缓存同步的 security 域 check-list 规则（如 helmet-check / comment-instruction /
 * env-exfiltration / dependency-scripts / hidden-link）以顶层 checks 数组承载检测项，
 * 若仍路由到 GuardEngine.run（checks.json 仅有 ARCH/LINT/TEST/SEC 四条）会永久「无可匹配」跳过。
 * 本契约允许将 security 域 check-list 规则改路由到基于 InjectionGuard 的真实检测引擎。
 */
export interface SecurityCheckEngineLike {
  // opts 设为 unknown：实现侧接受 { mode, target, checks, dryRun }，kernel 不反向依赖 @zh/security，
  // 由调用方（dispatch-evaluators）负责构造（与 GuardEngineLike.run 同一约定）。
  run(opts: unknown): Promise<{
    results?: Array<{ status?: string; message?: string }>;
  }>;
}

/**
 * SopRuleEngine 派发依赖的运行时视图。
 *
 * 拆分出的评估函数（inline-evaluators / dispatch-evaluators）通过它访问：
 * - toolAdapters：tool-dispatch 指令的工具适配器注册表
 * - guardEngine / inspectEngine：check-list / scanner-dispatch / preset 的外部引擎
 * - auditLogger：tool-dispatch 扫描后的审计日志（F0-4，对齐 inspect/security 调用点）
 * - evalDepth：当前评估重入深度（>1 表示已处于嵌套评估中，应切断回调避免死循环）
 */
export interface EngineHost {
  toolAdapters: Map<string, ToolAdapter>;
  guardEngine?: GuardEngineLike;
  inspectEngine?: InspectEngineLike;
  securityCheckEngine?: SecurityCheckEngineLike;
  /** 审计日志为副作用依赖：缺失或写入失败均不得影响扫描结果 */
  auditLogger?: AuditLogger;
  /** EventBus — 用于 tool:executed 等事件发射；缺失或发射失败均不得影响扫描结果 */
  eventBus?: EventBus;
  /** 工具 scope 判定：返回 false 表示工具不在当前项目画像 scope 内，tool-dispatch 应跳过 */
  toolScope?: (toolId: string) => boolean;
  evalDepth: number;
}
