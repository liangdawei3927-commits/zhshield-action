import type { SopRule } from './sop/_meta/sop-types';
import type { RuleContext } from './sop/_meta/rule-context';
import type {
  RuleEvaluation,
  RuleEngineReport,
  ContentInstruction,
} from './sop/_meta/rule-evaluation';
import { resolveEffectiveRule, trackConsecutiveFailures } from './sop/_meta/adaptive-severity';
import { computeBlocking } from './sop/_meta/rule-evaluation';
import type { ToolAdapter, ToolCallHook, GovernanceEvent } from '@zh/shared';
import { AuditLogger, wrapAdapter } from '@zh/shared';
import { ContentInterpreter } from './sop/_meta/content-interpreter';
import { SopRegistry } from './sop/_meta/sop-registry';
import { EventBus } from './bus';
import { Logger } from './log';
import type { EngineHost, GuardEngineLike, InspectEngineLike } from './runner/evaluator-host';
import {
  evalPatternScan,
  evalForbidden,
  evalForbiddenRegex,
  evalRequiredContent,
  evalThreshold,
  evalLayerBoundary,
} from './runner/inline-evaluators';
import {
  evalCheckList,
  evalScannerDispatch,
  evalToolDispatch,
  evalPreset,
} from './runner/dispatch-evaluators';
import { aggregate, errorEvaluation, skipEvaluation } from './runner/evaluation-builders';

/** 会回调 Guard/Inspect 引擎并可能再次进入 evaluateRules 的指令类型 */
const ENGINE_DISPATCH_TYPES = new Set(['preset', 'scanner-dispatch', 'check-list']);

/**
 * SopRuleEngine — SOP 规则引擎（runner.ts）
 *
 * 职责：
 * 1. 从 SopRegistry 获取规则，按 context 过滤
 * 2. 通过 ContentInterpreter 将规则内容解释为可执行指令
 * 3. 内联执行（patterns / forbidden / thresholds）或派发到 GuardEngine / InspectEngine
 * 4. 聚合评估结果返回 RuleEngineReport
 *
 * 评估逻辑按功能领域拆分：
 * - 内联评估（pattern-scan / forbidden / threshold / layer-boundary）→ runner/inline-evaluators
 * - 派发评估（check-list / scanner-dispatch / tool-dispatch / preset）→ runner/dispatch-evaluators
 * - 评估结果构造与聚合（skipped/error/aggregate）→ runner/evaluation-builders
 * - 文件扫描工具 → runner/scan-utils
 *
 * 长期架构定位：
 * - 系统的「大脑」：所有检查从 SOP 规则出发，而非从 checks.json 或硬编码适配器
 * - GuardEngine / InspectEngine 是「双手」：仅执行具体的工具调用
 */
export class SopRuleEngine {
  private registry: SopRegistry;
  private interpreter: ContentInterpreter;
  private eventBus: EventBus;
  private logger: Logger;

  /** 可选的外部引擎引用 — 用于派发 check-list / scanner-dispatch / preset 指令 */
  private guardEngine?: GuardEngineLike;
  private inspectEngine?: InspectEngineLike;

  /** ToolAdapter 注册表 — 用于 tool-dispatch 指令 */
  private toolAdapters = new Map<string, ToolAdapter>();

  /** 注册时织入适配器的调用钩子（F0-3；F1/F5 注入实际钩子，缺省空数组纯透传） */
  private readonly toolCallHooks: ToolCallHook[];

  /** 审计日志 — tool-dispatch 扫描后补记（F0-4，对齐 inspect/security 调用点） */
  private auditLogger: AuditLogger;

  /** F1-3：实例级连续失败计数器（ruleId → 连续 failed/error 次数；passed 归零，skipped 不动） */
  private readonly consecutiveFailures = new Map<string, number>();

  /** F1-3：项目健康基线分（@zh/scoring 注入；缺省 undefined = 基线升档关闭） */
  private readonly healthBaseline?: number;

  /** 指令类型 → 评估器策略表（替代 evaluateSingle 中的 switch 分派）。
   *  映射类型保证每个 handler 收到对应判别联合变体，类型安全；
   *  分派处对联合索引做一次局部断言以绕过 TS 相关联合的索引限制。 */
  private readonly evaluators: Partial<{
    [K in ContentInstruction['type']]: (
      rule: SopRule,
      instr: Extract<ContentInstruction, { type: K }>,
      context: RuleContext,
    ) => RuleEvaluation | Promise<RuleEvaluation>;
  }> = {
    'pattern-scan': (rule, instr, ctx) => evalPatternScan(rule, instr, ctx),
    forbidden: (rule, instr, ctx) => evalForbidden(rule, instr, ctx),
    'forbidden-regex': (rule, instr, ctx) => evalForbiddenRegex(rule, instr, ctx),
    'required-content': (rule, instr, ctx) => evalRequiredContent(rule, instr, ctx),
    threshold: (rule, instr, ctx) => evalThreshold(rule, instr, ctx, this.guardEngine),
    'check-list': (rule, instr, ctx) => evalCheckList(this.host, rule, instr, ctx),
    'layer-boundary': (rule, instr, ctx) => evalLayerBoundary(rule, instr, ctx),
    'scanner-dispatch': (rule, instr, ctx) => evalScannerDispatch(this.host, rule, instr, ctx),
    preset: (rule, instr, ctx) => evalPreset(this.host, rule, instr, ctx),
    'tool-dispatch': (rule, instr, ctx) => evalToolDispatch(this.host, rule, instr, ctx),
  };

  /**
   * 评估重入深度。preset / scanner-dispatch / check-list 会回调
   * InspectEngine.runScan / GuardEngine.run → 再次 evaluateRules，
   * 若不拦截会形成无限递归，拖死体检子进程。
   */
  private evalDepth = 0;

  constructor(
    registry: SopRegistry,
    options?: {
      eventBus?: EventBus;
      guardEngine?: GuardEngineLike;
      inspectEngine?: InspectEngineLike;
      /** 预注册的 ToolAdapter 列表 */
      toolAdapters?: Array<{ name: string; adapter: ToolAdapter }>;
      /** 审计日志注入点 — 缺省用 @zh/shared AuditLogger（写 ~/.zhshield/audit） */
      auditLogger?: AuditLogger;
      /** 工具调用钩子（F0-3）— 注册时织入 wrapAdapter；缺省空数组（纯透传） */
      hooks?: ToolCallHook[];
      /** 项目健康基线分（F1-3）— <60 时有效严重级整体上移一档；缺省 undefined = 关闭 */
      healthBaseline?: number;
    },
  ) {
    this.registry = registry;
    this.interpreter = new ContentInterpreter();
    this.eventBus = options?.eventBus ?? new EventBus();
    this.logger = new Logger('SopRuleEngine', 'info');
    this.guardEngine = options?.guardEngine;
    this.inspectEngine = options?.inspectEngine;
    this.auditLogger = options?.auditLogger ?? new AuditLogger();
    this.toolCallHooks = options?.hooks ?? [];
    this.healthBaseline = options?.healthBaseline;
    if (options?.toolAdapters) {
      for (const { name, adapter } of options.toolAdapters) {
        this.toolAdapters.set(name, this.wrapWithScopeGuard(adapter));
      }
    }
  }

  /** 注册单个 ToolAdapter */
  registerToolAdapter(name: string, adapter: ToolAdapter): void {
    this.toolAdapters.set(name, this.wrapWithScopeGuard(adapter));
  }

  /** F0-3 Hook 包装 + F5-2 越界事件转发（warn-only，经 EventBus 供 sentinel 消费） */
  private wrapWithScopeGuard(adapter: ToolAdapter): ToolAdapter {
    return wrapAdapter(adapter, this.toolCallHooks, {
      onScopeViolation: (violation, { options }) => {
        const payload: GovernanceEvent = {
          type: 'tool:scope-violation',
          payload: {
            tool: adapter.meta.id,
            projectId: options.projectId,
            file: violation.file,
            reason: violation.reason,
            timestamp: new Date(),
          },
        };
        void this.eventBus.emit(payload.type, payload.payload);
      },
    });
  }

  /** 派发评估函数的运行时视图（evalDepth 实时读取，保持重入判断与原行为一致） */
  private get host(): EngineHost {
    const readEvalDepth = () => this.evalDepth;
    return {
      toolAdapters: this.toolAdapters,
      guardEngine: this.guardEngine,
      inspectEngine: this.inspectEngine,
      auditLogger: this.auditLogger,
      eventBus: this.eventBus,
      get evalDepth() {
        return readEvalDepth();
      },
    };
  }

  // ─── 核心入口 ──────────────────────────────────────────

  /**
   * 评估规则：按 context 过滤 → 解释 → 执行 → 聚合
   */
  async evaluateRules(context: RuleContext): Promise<RuleEngineReport> {
    const start = Date.now();
    const nested = this.evalDepth > 0;
    this.evalDepth += 1;

    try {
      const rules = this.filterRulesByContext(context);
      const evaluations = rules.length === 0 ? [] : await this.evaluateAll(rules, context, nested);

      const report = aggregate(evaluations, Date.now() - start);
      await this.emit('rule-engine:evaluated', report);
      return report;
    } finally {
      this.evalDepth -= 1;
    }
  }

  private filterRulesByContext(context: RuleContext): SopRule[] {
    let rules = this.registry.getActive();
    if (context.domain) {
      rules = rules.filter((r) => r.domain === context.domain);
    }
    if (context.action) {
      rules = rules.filter((r) => r.action === context.action);
    }
    return rules;
  }

  private async evaluateAll(
    rules: SopRule[],
    context: RuleContext,
    nested: boolean,
  ): Promise<RuleEvaluation[]> {
    const evaluations: RuleEvaluation[] = [];
    for (const rule of rules) {
      const evalStart = Date.now();
      const instruction = this.interpreter.interpret(rule);
      // F1-3：升级判定用本次自增前的计数值；effectiveRule 仅在 severity 实际变化时浅拷贝，registry 原对象不被修改
      const effectiveRule = resolveEffectiveRule(
        rule,
        this.consecutiveFailures,
        this.healthBaseline,
      );
      try {
        // perf rule false positive: arg depends on loop var via dataflow
        // eslint-disable-next-line perf/perf-no-serial-await
        const result = await this.evaluateOne(effectiveRule, instruction, context, nested);
        result.durationMs = Date.now() - evalStart;
        // F1-4：阻断判定（附加元数据，不影响 ok 公式）；severity 取升级后的有效值（effectiveRule.severity），阈值取 registry 原规则
        result.blocking = computeBlocking(
          result.status,
          effectiveRule.severity,
          rule.blockingThreshold,
        );
        trackConsecutiveFailures(this.consecutiveFailures, rule.id, result.status);
        evaluations.push(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        trackConsecutiveFailures(this.consecutiveFailures, rule.id, 'error');
        evaluations.push(errorEvaluation(effectiveRule, message, Date.now() - evalStart));
      }
    }
    return evaluations;
  }

  private async evaluateOne(
    rule: SopRule,
    instruction: ContentInstruction,
    context: RuleContext,
    nested: boolean,
  ): Promise<RuleEvaluation> {
    const engine = rule.domain === 'guard' ? ('guard' as const) : ('inspect' as const);
    // dryRun 模式：跳过所有外部派发（scanner-dispatch / tool-dispatch / preset / check-list / threshold）
    if (context.dryRun && this.isExternalDispatch(instruction.type)) {
      return skipEvaluation(rule, `[dryRun] 跳过外部工具: ${instruction.type}`, engine);
    }

    // 嵌套评估时跳过会回调用引擎的指令，切断
    // evaluateRules → preset/scanner/check-list → runScan/run → evaluateRules 死循环
    if (nested && ENGINE_DISPATCH_TYPES.has(instruction.type)) {
      return skipEvaluation(rule, `跳过嵌套 ${instruction.type} 派发（防止规则引擎重入）`, engine);
    }

    return this.evaluateSingle(rule, instruction, context);
  }

  private isExternalDispatch(type: ContentInstruction['type']): boolean {
    return (
      type === 'scanner-dispatch' ||
      type === 'tool-dispatch' ||
      type === 'preset' ||
      type === 'check-list' ||
      type === 'threshold'
    );
  }

  /**
   * SOP 驱动型 Guard 检查 — 筛选 guard domain 规则执行
   */
  async runGuard(context: RuleContext): Promise<RuleEngineReport> {
    return this.evaluateRules({ ...context, domain: 'guard' });
  }

  /**
   * SOP 驱动型 Inspect 巡检 — 筛选 inspect / security domain 规则执行
   */
  async runInspect(context: RuleContext): Promise<RuleEngineReport> {
    return this.evaluateRules({ ...context, domain: context.domain ?? 'inspect' });
  }

  // ─── 单条规则评估 ──────────────────────────────────────

  private async evaluateSingle(
    rule: SopRule,
    instruction: ContentInstruction,
    context: RuleContext,
  ): Promise<RuleEvaluation> {
    const evaluator = this.evaluators[instruction.type] as
      | ((
          rule: SopRule,
          instr: ContentInstruction,
          context: RuleContext,
        ) => RuleEvaluation | Promise<RuleEvaluation>)
      | undefined;
    if (!evaluator) {
      return {
        rule,
        status: 'error',
        message: `Unknown instruction type: ${instruction.type}`,
        durationMs: 0,
        targetEngine: 'inspect',
        timestamp: new Date(),
      };
    }
    return evaluator(rule, instruction, context);
  }

  // ─── 辅助 ──────────────────────────────────────────────

  private async emit(event: string, payload: RuleEngineReport): Promise<void> {
    try {
      await this.eventBus.emit(event, payload);
    } catch {
      // 事件总线失败不阻断主流程
    }
  }
}

export type {
  RuleEvaluation,
  RuleEngineReport,
  ContentInstruction,
  ToolDispatchInstruction,
} from './sop/_meta/rule-evaluation';
export type { RuleContext } from './sop/_meta/rule-context';
export type { ToolAdapter } from '@zh/shared';
export { ContentInterpreter } from './sop/_meta/content-interpreter';
