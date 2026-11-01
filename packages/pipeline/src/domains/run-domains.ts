/**
 * 按域建任务的无头驱动（《07》§7.4 / C5 / A13 / A14）。
 *
 * 语义：
 *   - **一域一执行器**（C1）：执行器只跑本域职责，非 Owner 域读结论不重扫；
 *   - **域级隔离**（A13）：单域抛错 / 超预算只把自己的记录降为 `unavailable`，
 *     其余域照常执行 —— 绝不整体失败、绝不把失败折算成 0 分或满分（C4）；
 *   - **逐域计时**（A14 前置）：每条记录带 `durationMs`，账本给出 `sumMs` 与墙钟 `wallMs`，
 *     优化前后可直接对比，不再靠"感觉变快了"。
 *
 * 预算语义的诚实边界：外部扫描器起的是子进程，本层**无法真正中断**它，
 * 超预算只能把该域记录为 `unavailable` 并继续下一域。因此默认预算取自
 * `@zh/shared` 的 `SCAN_DOMAIN_BUDGETS`（宽于常规耗时），把"超预算"当告警用，
 * 而不是当调度手段用。
 */
import {
  SCAN_DOMAIN_BUDGETS,
  withHardTimeout,
  type DomainId,
  type DomainRunStatus,
} from '@zh/shared';
import { DEFAULT_DOMAIN_EXECUTORS, RUNTIME_ONLY_DOMAINS } from './executors';
import type {
  DomainExecutionContext,
  DomainExecution,
  DomainExecutor,
  DomainRunLedger,
  DomainRunOptions,
  DomainRunRecord,
} from './types';

/** 静态扫描八域：预算表即清单，不另立一份（新增域只改注册表） */
export const STATIC_SCAN_DOMAINS: readonly DomainId[] = Object.keys(
  SCAN_DOMAIN_BUDGETS,
) as DomainId[];

/** 该域的预算：调用方覆盖优先，否则取共享预算表（表内没有的域不设预算） */
function budgetFor(domain: DomainId, options: DomainRunOptions): number | undefined {
  return (
    options.budgets?.[domain] ?? SCAN_DOMAIN_BUDGETS[domain as keyof typeof SCAN_DOMAIN_BUDGETS]
  );
}

/** 没给执行器的记录。没给 ≠ 该域有问题：运行时域本就不参与静态扫描，techdebt 需宿主注入 */
function notRunRecord(domain: DomainId, budgetMs: number | undefined): DomainRunRecord {
  return {
    domain,
    status: 'not-run',
    durationMs: 0,
    ...(budgetMs !== undefined ? { budgetMs } : {}),
    reason: RUNTIME_ONLY_DOMAINS.has(domain)
      ? `域 ${domain} 不属于静态扫描（运行时域），本次无头流水线不执行`
      : `域 ${domain} 未提供执行器（需调用方注入），本次未执行`,
  };
}

function successRecord(
  domain: DomainId,
  execution: DomainExecution,
  budgetMs: number | undefined,
  durationMs: number,
): DomainRunRecord {
  return {
    domain,
    status: execution.status ?? 'ok',
    durationMs,
    ...(budgetMs !== undefined ? { budgetMs } : {}),
    ...(execution.report !== undefined ? { report: execution.report } : {}),
    ...(execution.detail ? { detail: execution.detail } : {}),
    ...(execution.reason ? { reason: execution.reason } : {}),
  };
}

/**
 * 执行失败 / 超预算的记录。
 *
 * 超预算判据只看**本层抛出的超时文案**，不靠"耗时 >= 预算"反推：注入时钟（测试 /
 * 无头脚本）下耗时可能为 0，反推会漏标记；真实时钟下也可能因计时抖动差几毫秒。
 */
function failureRecord(input: {
  domain: DomainId;
  err: unknown;
  budgetMs: number | undefined;
  timeoutMessage: string | undefined;
  durationMs: number;
}): DomainRunRecord {
  const { domain, err, budgetMs, timeoutMessage, durationMs } = input;
  const message = err instanceof Error ? err.message : String(err);
  const overBudget = timeoutMessage !== undefined && message === timeoutMessage;
  return {
    domain,
    status: 'unavailable',
    durationMs,
    ...(budgetMs !== undefined ? { budgetMs } : {}),
    reason: message,
    ...(overBudget ? { overBudget: true } : {}),
  };
}

/** 单域执行：把执行器返回收敛成一条记录，异常一律不向上抛（A13） */
async function runOne(
  domain: DomainId,
  executor: DomainExecutor | undefined,
  options: DomainRunOptions,
  now: () => number,
): Promise<DomainRunRecord> {
  const budgetMs = budgetFor(domain, options);
  if (!executor) return notRunRecord(domain, budgetMs);

  const ctx: DomainExecutionContext = {
    repoRoot: options.repoRoot,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };
  const timeoutMessage =
    budgetMs === undefined ? undefined : `[domains] 域 ${domain} 超过 ${budgetMs}ms 预算`;

  const start = now();
  try {
    const execution = await (budgetMs === undefined
      ? executor(ctx)
      : withHardTimeout(executor(ctx), budgetMs, timeoutMessage as string));
    return successRecord(domain, execution, budgetMs, now() - start);
  } catch (err) {
    return failureRecord({ domain, err, budgetMs, timeoutMessage, durationMs: now() - start });
  }
}

/**
 * 跑一次全量（或指定子集）域，返回逐域账本。
 *
 * 每次调用都是独立的一次运行：执行器不共享状态，账本不跨运行累加。
 */
export async function runDomains(options: DomainRunOptions): Promise<DomainRunLedger> {
  const now = options.now ?? Date.now;
  const domains = options.domains ?? STATIC_SCAN_DOMAINS;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const startedAtMs = now();
  const records = new Array<DomainRunRecord>(domains.length);

  const executorOf = (domain: DomainId): DomainExecutor | undefined =>
    options.executors?.[domain] ?? DEFAULT_DOMAIN_EXECUTORS[domain];

  if (concurrency === 1) {
    for (let i = 0; i < domains.length; i += 1) {
      records[i] = await runOne(domains[i], executorOf(domains[i]), options, now);
    }
  } else {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, domains.length) }, async () => {
      while (cursor < domains.length) {
        const index = cursor;
        cursor += 1;
        records[index] = await runOne(domains[index], executorOf(domains[index]), options, now);
      }
    });
    await Promise.all(workers);
  }

  const wallMs = now() - startedAtMs;
  return {
    repoRoot: options.repoRoot,
    startedAt: new Date(startedAtMs).toISOString(),
    sumMs: records.reduce((sum, record) => sum + record.durationMs, 0),
    wallMs,
    concurrency,
    records,
  };
}

/** 单域便利入口：等价于 `runDomains({ domains: [domain] })` 取首条记录 */
export async function runDomain(
  domain: DomainId,
  options: Omit<DomainRunOptions, 'domains'>,
): Promise<DomainRunRecord> {
  const ledger = await runDomains({ ...options, domains: [domain] });
  return ledger.records[0];
}

/** 账本单行摘要（CLI / 日志用）：`domain status 1.2s [reason]` */
export function formatDomainRecord(record: DomainRunRecord): string {
  const seconds = (record.durationMs / 1000).toFixed(2);
  const status: DomainRunStatus = record.status;
  const flag = record.overBudget === true ? ' ⚠超预算' : '';
  const reason = record.reason ? ` — ${record.reason}` : '';
  return `${record.domain} ${status} ${seconds}s${flag}${reason}`;
}
