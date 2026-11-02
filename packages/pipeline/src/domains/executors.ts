/**
 * 各治理域的默认执行器（《07》§三 职责矩阵）。
 *
 * 每个执行器只做**本域**的事（C1），需要别的域结论时读快照不重扫（C3）。
 * 依赖一律 `await import()` 懒加载：跑单域不该把十个引擎全拉进内存
 * （8GB Intel Mac 上这是能否跑完的差别，不是洁癖）。
 *
 * 进度事件只传结构化信息（`DomainEvent`），文案由展示层渲染。
 */
import type { GovernanceEvent, DomainId } from '@zh/shared';
import type { RuleEngineReport } from '@zh/kernel';
import type { RefactorReport } from '@zh/refactor';
import type { DomainExecutionContext, DomainExecution, DomainExecutor } from './types';
import { loadGuardConclusions } from '../domain-snapshot';
import { scanDeps } from './deps-scan';

/** 运行时域：不属于静态扫描，`runDomains` 不必为它们要求执行器 */
export const RUNTIME_ONLY_DOMAINS: ReadonlySet<DomainId> = new Set<DomainId>([
  'sentinel',
  'backup',
  'reports',
]);

/**
 * 规则引擎报告的**执行健康度**（不是结论好坏）。
 *
 * 一条都没评估 = 没查（`unavailable`，禁止折算成 0/100 分）；
 * 有跳过 / 出错 / 降级 = 部分工序没跑成（`partial`，A7 的 `degraded` 在此显形）；
 * 其余才算 `ok`。findings 多少不影响这里 —— 查出问题不等于执行失败。
 */
function ruleEngineExecution(report: RuleEngineReport): DomainExecution {
  const scanned = report.total - report.skipped;
  if (report.total === 0) {
    return { report, status: 'unavailable', reason: '无规则可评估（规则集为空），本次未检测' };
  }
  if (scanned === 0) {
    return {
      report,
      status: 'unavailable',
      reason: `全部 ${report.total} 条规则被跳过（工具/前提不可用），本次未检测`,
    };
  }
  if (report.skipped > 0 || report.errors > 0 || (report.degraded ?? 0) > 0) {
    return {
      report,
      status: 'partial',
      reason: `跳过 ${report.skipped} 条 / 出错 ${report.errors} 条 / 降级 ${report.degraded ?? 0} 条`,
    };
  }
  return { report, status: 'ok' };
}

/** 项目体检：质量评分（规则驱动的 SOP 巡检，规则集由装配层统一装载） */
export async function runInspectDomain(ctx: DomainExecutionContext): Promise<DomainExecution> {
  if (!ctx.runner) {
    return { status: 'unavailable', reason: '体检域需要 PipelineRunner（规则引擎在装配层）' };
  }
  const report = (await ctx.runner.runSopInspect({ domains: ['inspect'] })) as RuleEngineReport;
  return ruleEngineExecution(report);
}

/** 门禁系统：纯判定 —— 只读各域已落盘结论，不调用任何扫描器（O8/C3/A6） */
export async function runGuardDomain(ctx: DomainExecutionContext): Promise<DomainExecution> {
  if (!ctx.runner) {
    return { status: 'unavailable', reason: '门禁域需要 PipelineRunner（判定规则在装配层）' };
  }
  const conclusions = await loadGuardConclusions(ctx.repoRoot);
  const report = (await ctx.runner.runSopGuard({ dryRun: false, conclusions })) as RuleEngineReport;
  return ruleEngineExecution(report);
}

/** 代码重构：坏味道 + 重复代码明细（唯一 Owner，不参与质量评分） */
export interface RefactorScanResult {
  report: RefactorReport;
  /** 被棘轮基线豁免的存量条数（进度文案用） */
  suppressedCount: number;
}

/** 重构扫描：分析 + 棘轮基线过滤（`PipelineRunner.runRefactor` 与本执行器共用） */
export async function scanRefactor(
  repoRoot: string,
  options?: { skipBaseline?: boolean },
): Promise<RefactorScanResult> {
  const [{ RefactorEngine, applyRefactorBaseline }, { loadRefactorBaseline }] = await Promise.all([
    import('@zh/refactor'),
    import('@zh/shared'),
  ]);
  const report = await new RefactorEngine().analyzeDirectory(repoRoot);
  // 棘轮基线：.zhshield/refactor-baseline.json 存在时只报增量；无基线全量（历史行为）
  const baselineCounts = options?.skipBaseline ? null : await loadRefactorBaseline(repoRoot);
  if (!baselineCounts) return { report, suppressedCount: 0 };
  const filtered = applyRefactorBaseline(report, baselineCounts, repoRoot);
  return { report: filtered.report, suppressedCount: filtered.suppressedCount };
}

export async function runRefactorDomain(ctx: DomainExecutionContext): Promise<DomainExecution> {
  const { report, suppressedCount } = await scanRefactor(ctx.repoRoot);
  return { report, detail: { suppressedCount } };
}

/**
 * 安全中心：密钥 / 注入 / 恶意代码 / 污点链（不报依赖 CVE —— 归 deps，O10）。
 *
 * 引擎事件必须接通 `onEvent`：5 分钟安全扫描若丢了 `tool:*` 事件，用户只看到
 * "10% → 一瞬间 100%"，既无进度也无从判断哪个工具失败。
 *
 * `includeDependencyOwned=false`：域内扫描不得重扫依赖 CVE（deps）与未使用依赖
 * （garbage）——《07》C3，且不再为 `pnpm audit` 付网络与 3s 级耗时。
 */
export async function runSecurityDomain(ctx: DomainExecutionContext): Promise<DomainExecution> {
  const { SecurityEngine } = await import('@zh/security');
  const onEvent = ctx.onEvent;
  const emitter = onEvent
    ? {
        emit: (event: GovernanceEvent) => {
          onEvent({
            domain: 'security',
            kind: event.type,
            payload: event.payload as unknown as Record<string, unknown>,
          });
        },
      }
    : undefined;
  const engine = new SecurityEngine(emitter);
  engine.registerDefaultAdapters();
  const report = await engine.runSecurityScan(ctx.repoRoot, ctx.repoRoot, {
    includeDependencyOwned: false,
  });
  return { report };
}

/** 性能优化：只出建议、不参与质量扣分（静态分析，不执行项目代码） */
export interface PerformanceIssueData {
  id: string;
  ruleId: string;
  severity: string;
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  autoFixable: boolean;
}

/**
 * 按 issue.id 去重（引擎 id 已含 file + 具体维度，如 `runtime-sync-io-{file}-{fnName}`）。
 *
 * 不要退回按 `ruleId:file` 去重 —— 那会把同一文件里的 readFileSync 与 execSync
 * 两条独立问题压成 1 条（少报）。
 */
function dedupePerformanceIssues(issues: PerformanceIssueData[]): PerformanceIssueData[] {
  const seen = new Set<string>();
  const result: PerformanceIssueData[] = [];
  for (const issue of issues) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    result.push(issue);
  }
  return result;
}

export async function runPerformanceDomain(ctx: DomainExecutionContext): Promise<DomainExecution> {
  const startedAt = Date.now();
  const { PerformanceEngine } = await import('@zh/performance');
  const engineReport = new PerformanceEngine().scan(ctx.repoRoot);
  const issues = dedupePerformanceIssues(
    engineReport.issues.map((issue) => ({
      id: issue.id,
      ruleId: issue.ruleId,
      severity: issue.severity,
      file: issue.file,
      line: issue.line,
      message: issue.message,
      suggestion: issue.suggestion,
      autoFixable: issue.autoFixable,
    })),
  );
  return {
    report: {
      summary: {
        total: issues.length,
        autoFixable: issues.filter((issue) => issue.autoFixable).length,
      },
      issues,
      metadata: { duration: Date.now() - startedAt, timestamp: new Date().toISOString() },
    },
  };
}

/**
 * 垃圾清理：文件系统检测器 + garbage 域 SOP 规则（死代码 / 未使用依赖）。
 *
 * 重复代码不在此列（O1 唯一归重构域）；也不调安全引擎取 garbage 字段
 * （为读一个字段跑完整安全扫描属于跨域借调触发权）。
 * 规则通道失败只降级为"仅文件系统检测"（`partial`），报告里 `ruleChannelRan=false` 留痕。
 */
export async function runGarbageDomain(ctx: DomainExecutionContext): Promise<DomainExecution> {
  const { detectFsGarbage, buildGarbageReport } = await import('@zh/garbage');
  const fsItems = await detectFsGarbage(ctx.repoRoot);

  let evaluations: readonly unknown[] = [];
  let ruleChannelRan = false;
  let reason: string | undefined;

  if (!ctx.runner) {
    reason = '未提供 PipelineRunner，垃圾规则通道未执行（仅文件系统检测）';
  } else {
    ctx.onEvent?.({ domain: 'garbage', kind: 'rule-channel-started' });
    try {
      const sop = (await ctx.runner.runSopInspect({ domains: ['garbage'] })) as RuleEngineReport;
      evaluations = sop.evaluations ?? [];
      ruleChannelRan = true;
    } catch (err) {
      reason = `垃圾规则通道异常，降级为仅文件系统检测: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const report = buildGarbageReport({
    projectPath: ctx.repoRoot,
    fsItems,
    evaluations: evaluations as Parameters<typeof buildGarbageReport>[0]['evaluations'],
    ruleChannelRan,
  });
  return {
    report,
    status: ruleChannelRan ? 'ok' : 'partial',
    ...(reason ? { reason } : {}),
    detail: { ruleChannelRan },
  };
}

/** 依赖管家：依赖图谱 / 许可证 / 投毒 / 锁文件 / 升级 / CVE（O10 唯一 Owner） */
export async function runDepsDomain(ctx: DomainExecutionContext): Promise<DomainExecution> {
  const { report } = await scanDeps(ctx.repoRoot);
  return { report, detail: { cve: report.cve.status } };
}

/** 默认执行器注册表：只登记本层能独立跑起来的域 */
export const DEFAULT_DOMAIN_EXECUTORS: Partial<Record<DomainId, DomainExecutor>> = {
  inspect: runInspectDomain,
  guard: runGuardDomain,
  security: runSecurityDomain,
  deps: runDepsDomain,
  garbage: runGarbageDomain,
  performance: runPerformanceDomain,
  refactor: runRefactorDomain,
  // techdebt 需要 @zh/scoring + 数据库（宿主能力），由调用方注入；
  // sentinel / backup / reports 属运行时域 / 只读聚合，不参与静态扫描。
};
