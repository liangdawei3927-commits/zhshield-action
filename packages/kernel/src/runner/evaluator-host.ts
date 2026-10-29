import type { ToolAdapter, AuditLogger } from '@zh/shared';
import type { EventBus } from '../bus';
import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';

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
 * 度量采集结果。
 *
 * - `metrics`：确实测到的指标（键名须与规则 thresholds 一致）。**测不到的不要填、不要用 0 顶替** ——
 *   缺项会让 evalThreshold 落 degraded skipped（未检测 ≠ 通过）。
 * - `unavailableReason`：整条规则的度量口径无法满足时（而非个别指标缺失）给出的人类可读原因，
 *   让面板上「降级」直接说清是**没实现**、**缺产物**还是**口径不匹配**，而不是笼统的「缺数据源」。
 */
export interface RuleMetricsResult {
  metrics?: Record<string, number | undefined>;
  unavailableReason?: string;
}

/**
 * 规则度量数据源 — threshold 指令的实测值提供者。
 *
 * **为什么是「按规则」而不是「按项目一次性给一袋指标」**：
 * 云端规则里 `threshold: 70`（单数写法）会被解释器折算成 `thresholds = { value: 70 }`，
 * 即三条不同的分数型规则（健康分 / 质量分 / 覆盖率）共用同一个键 `value`。
 * 若只按指标名返回一袋数值，这三条规则必然读到同一个数 —— 语义直接错位。
 * 故签名带 `rule`，由提供方按 rule.id（或 domain+action）决定该条的指标口径。
 *
 * **为什么注入而不是 kernel 自己算**：复杂度需要 AST、覆盖率需要读报告文件，
 * 这些能力在 @zh/refactor / 文件系统侧，kernel 反向依赖它们会形成环
 * （@zh/pipeline → @zh/kernel 已是单向）。故只在此声明契约，实现放调用方。
 */
export type RuleMetricsProvider = (
  rule: SopRule,
  context: RuleContext,
) => Promise<RuleMetricsResult> | RuleMetricsResult;

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
  /** 阈值指令的实测值提供者；缺省时 threshold 规则一律落 degraded skipped（未检测 ≠ 通过） */
  metricsProvider?: RuleMetricsProvider;
  /** tool-dispatch 单次工具扫描硬上限（ms）；缺省 300000（5 分钟，大型 monorepo trivy/semgrep 需更长时间） */
  toolScanTimeoutMs?: number;
  evalDepth: number;
}
