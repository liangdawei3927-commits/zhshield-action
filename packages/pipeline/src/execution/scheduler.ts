/**
 * Scheduler —— 执行层调度（《07》§7.2 / §7.4 / §7.5）。
 *
 * 职责只有四件，其余一概不做：
 *   1. **合并执行**（A12）：多个域申请同一 `(tool, targets, args)` → 交给 `ToolExecutor` 只起一次进程；
 *   2. **按 owner 广播**（C1/C2）：原始 findings 经 `routeFindings` 投递，申请方拿不到别人的 issue；
 *   3. **域级预算与熔断**（§7.5）：单工具硬超时 → 该工具 skipped；域超预算 → 该域 unavailable，其余域继续；
 *   4. **前提判定**（A15）：`requires` 为 network/db 且不可达 → skipped，不起进程、不进 issues。
 *
 * 并发恒为 1（按域顺序执行）——本机 8GB，且顺序执行让"谁先跑、谁被预算掐断"可复现。
 * 一域出错/超时**永不**向上抛出（A13）：异常只降级为该工具记录。
 */
import {
  SCAN_DOMAIN_BUDGETS,
  findToolCapability,
  withHardTimeout,
  type DomainId,
  type ToolId,
  type ToolRunRequirement,
} from '@zh/shared';

import {
  routeFindings,
  type DistributionRecord,
  type RoutableFinding,
  type UnroutedFinding,
} from './router';
import { ToolExecutor, type ToolInvocation } from './tool-executor';

/** 单个工具请求：申请域 + 起进程函数 */
export interface ToolRequest<T extends RoutableFinding> {
  tool: ToolId;
  targets: readonly string[];
  args?: readonly string[];
  /** 真正起进程并返回原始 findings；允许抛错（由调度器降级为 error 记录） */
  run: () => Promise<readonly T[]>;
}

/** 一个域的任务计划 */
export interface DomainPlan<T extends RoutableFinding> {
  domain: DomainId;
  requests: readonly ToolRequest<T>[];
}

/** 工具级结果状态：`skipped` 的原因写在 `reason`（未登记 / 前提不可达 / 预算耗尽） */
export type ToolRunStatus = 'ok' | 'timeout' | 'error' | 'skipped';

/** 单工具执行记录 */
export interface ToolRunRecord<T extends RoutableFinding> {
  tool: ToolId;
  status: ToolRunStatus;
  findings: readonly T[];
  /** 复用本次运行中别的域已经起过的进程 */
  reused: boolean;
  reason?: string;
}

/** 域级状态（`not-run` 留给"没有任何工具的域"，如门禁纯判定） */
export type DomainRunStatus = 'ok' | 'partial' | 'unavailable' | 'not-run';

/** 域级调度结果 */
export interface DomainRunOutcome<T extends RoutableFinding> {
  domain: DomainId;
  status: DomainRunStatus;
  tools: readonly ToolRunRecord<T>[];
  /** 仅本域作为 owner 的 findings */
  findings: readonly T[];
  reason?: string;
}

export interface SchedulerOptions {
  /** 复用同一实例跨域共享；缺省内部新建 */
  executor?: ToolExecutor;
  /** 域级预算覆盖；缺省读 `SCAN_DOMAIN_BUDGETS`，表内没有的域（哨兵/备份）不设预算 */
  budgets?: Partial<Record<DomainId, number>>;
  /** 单工具硬超时覆盖；缺省读 `TOOL_CAPABILITIES.hardTimeoutMs` */
  hardTimeouts?: Partial<Record<ToolId, number>>;
  /** 运行前提可用性（network/db）；缺省一律视为可用，由调用方注入真实探测 */
  isRequirementAvailable?: (requirement: ToolRunRequirement) => boolean;
  /** 时钟（测试注入用，缺省 `Date.now`） */
  now?: () => number;
}

/** 一次调度的全部产出 */
export interface SchedulerResult<T extends RoutableFinding> {
  /** 计划域按输入顺序在前；只收到广播结论的 owner 域追加在后 */
  domains: DomainRunOutcome<T>[];
  unrouted: UnroutedFinding<T>[];
  distribution: DistributionRecord[];
}

/** 工具执行（规范化后）的中间形态，永不 reject */
interface ToolExecOutcome<T extends RoutableFinding> {
  status: 'ok' | 'timeout' | 'error';
  findings: readonly T[];
  reason?: string;
}

export class Scheduler {
  private readonly executor: ToolExecutor;
  private readonly budgets: Partial<Record<DomainId, number>>;
  private readonly hardTimeouts: Partial<Record<ToolId, number>>;
  private readonly isRequirementAvailable: (requirement: ToolRunRequirement) => boolean;
  private readonly now: () => number;

  constructor(options: SchedulerOptions = {}) {
    this.executor = options.executor ?? new ToolExecutor();
    this.budgets = options.budgets ?? SCAN_DOMAIN_BUDGETS;
    this.hardTimeouts = options.hardTimeouts ?? {};
    this.isRequirementAvailable = options.isRequirementAvailable ?? (() => true);
    this.now = options.now ?? Date.now;
  }

  /** 某工具（或全部）实际起进程次数 —— A12 断言入口 */
  invocationCount(tool?: ToolId): number {
    return this.executor.invocationCount(tool);
  }

  /**
   * 跑一次全量调度。
   *
   * 每次调用都是"新的一次运行"：先 reset，保证上一次的缓存/计数不会让 A12 的
   * "进程次数 = 1" 变成"跨运行复用 0 次"。
   */
  async run<T extends RoutableFinding>(
    plans: readonly DomainPlan<T>[],
  ): Promise<SchedulerResult<T>> {
    this.executor.reset();
    const raw: T[] = [];
    const outcomes: DomainRunOutcome<T>[] = [];

    for (const plan of plans) {
      outcomes.push(await this.runDomain(plan, raw));
    }

    const routed = routeFindings(raw);
    return {
      domains: attachByOwner(outcomes, routed.byOwner),
      unrouted: routed.unrouted,
      distribution: routed.distribution,
    };
  }

  private async runDomain<T extends RoutableFinding>(
    plan: DomainPlan<T>,
    raw: T[],
  ): Promise<DomainRunOutcome<T>> {
    if (plan.requests.length === 0) {
      return { domain: plan.domain, status: 'not-run', tools: [], findings: [] };
    }

    const start = this.now();
    const budgetMs = this.budgets[plan.domain];
    const tools: ToolRunRecord<T>[] = [];
    let budgetExhausted = false;

    for (const request of plan.requests) {
      if (!budgetExhausted && budgetMs !== undefined && this.now() - start >= budgetMs) {
        budgetExhausted = true;
      }
      tools.push(
        budgetExhausted
          ? this.skipByBudget(plan.domain, request, budgetMs as number)
          : await this.runRequest(request, raw),
      );
    }

    return {
      domain: plan.domain,
      status: domainStatus(tools, budgetExhausted),
      tools,
      findings: [],
      ...(budgetExhausted
        ? { reason: `域 ${plan.domain} 已用尽 ${budgetMs}ms 预算，剩余工具未执行` }
        : {}),
    };
  }

  private skipByBudget<T extends RoutableFinding>(
    domain: DomainId,
    request: ToolRequest<T>,
    budgetMs: number,
  ): ToolRunRecord<T> {
    return {
      tool: request.tool,
      status: 'skipped',
      findings: [],
      reused: false,
      reason: `域 ${domain} 已用尽 ${budgetMs}ms 预算，工具 ${request.tool} 未执行`,
    };
  }

  /** 单工具请求：能力/前提校验 → 合并执行 → 组装记录 */
  private async runRequest<T extends RoutableFinding>(
    request: ToolRequest<T>,
    raw: T[],
  ): Promise<ToolRunRecord<T>> {
    const capability = findToolCapability(request.tool);
    if (!capability) {
      return {
        tool: request.tool,
        status: 'skipped',
        findings: [],
        reused: false,
        reason: `工具 ${request.tool} 未在能力注册表登记，缺少预算/超时/前提声明，已跳过`,
      };
    }
    if (!this.isRequirementAvailable(capability.requires)) {
      return {
        tool: request.tool,
        status: 'skipped',
        findings: [],
        reused: false,
        reason: `运行前提不可达: ${capability.requires}，工具 ${request.tool} 已跳过`,
      };
    }

    const hardTimeoutMs = this.hardTimeouts[request.tool] ?? capability.hardTimeoutMs;
    const { result, reused } = await this.executor.executeOnce(invocationOf(request), () =>
      this.execute(request, hardTimeoutMs, raw),
    );
    return { tool: request.tool, ...result, reused };
  }

  /**
   * 真实执行一次：硬超时 + 异常收敛，永不 reject（失败结果同样进 ToolExecutor 缓存，
   * 避免"一次失败 → 多域各重跑一次"把 A12 打回 ≥3）。
   */
  private async execute<T extends RoutableFinding>(
    request: ToolRequest<T>,
    hardTimeoutMs: number,
    raw: T[],
  ): Promise<ToolExecOutcome<T>> {
    const timeoutMark = `[scheduler] 工具 ${request.tool} 超过 ${hardTimeoutMs}ms 硬上限，已跳过`;
    try {
      const findings = await withHardTimeout(
        Promise.resolve().then(request.run),
        hardTimeoutMs,
        timeoutMark,
      );
      raw.push(...findings);
      return { status: 'ok', findings };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: message === timeoutMark ? 'timeout' : 'error',
        findings: [],
        reason: message,
      };
    }
  }
}

function invocationOf<T extends RoutableFinding>(request: ToolRequest<T>): ToolInvocation {
  return { tool: request.tool, targets: request.targets, args: request.args };
}

/** 域状态：预算耗尽或无一工具成功 → unavailable；有失败但仍有成功 → partial */
function domainStatus(
  tools: readonly ToolRunRecord<RoutableFinding>[],
  budgetExhausted: boolean,
): DomainRunStatus {
  const ok = tools.filter((t) => t.status === 'ok').length;
  if (budgetExhausted) return 'unavailable';
  if (ok === tools.length) return 'ok';
  return ok > 0 ? 'partial' : 'unavailable';
}

/**
 * 按 owner 广播：计划域拿自己的桶；只收到别人跑出的结论的 owner 域追加为 `tools=[]`
 * 的条目（C1/C2：结论共享，检测不共享）。
 */
function attachByOwner<T extends RoutableFinding>(
  outcomes: readonly DomainRunOutcome<T>[],
  byOwner: Partial<Record<DomainId, T[]>>,
): DomainRunOutcome<T>[] {
  const planned = outcomes.map((outcome) => ({
    ...outcome,
    findings: byOwner[outcome.domain] ?? [],
  }));

  const extras: DomainRunOutcome<T>[] = (Object.keys(byOwner) as DomainId[])
    .filter((domain) => !planned.some((outcome) => outcome.domain === domain))
    .sort()
    .map((domain) => ({
      domain,
      status: 'ok' as const,
      tools: [],
      findings: byOwner[domain] ?? [],
    }));

  return [...planned, ...extras];
}
