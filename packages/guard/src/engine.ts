import type { CheckOptions, CheckResult, CheckConfig, GuardReport, Adapter } from './types';
import type { EventEmitter, GuardStage } from '@zh/shared';
import type { SopRuleEngine, RuleEvaluation } from '@zh/kernel';
import { NOOP_EMITTER } from '@zh/shared';
import { ConfigLoader } from './config-loader';
import { AdapterRegistry } from './adapter-registry';
import { ResultNormalizer } from './result-normalizer';

/**
 * SOP 评估状态 → CheckResult 状态映射。
 *
 * `skipped` 的落地值不在这里定（要看 `ev.degraded` 才能分出降级与让位），
 * 见 `resolveEvalStatus`。留 `'skipped'` 作为无附加信息时的兜底。
 */
const EVAL_STATUS_MAP: Record<string, CheckResult['status']> = {
  passed: 'passed',
  failed: 'failed',
  error: 'error',
  skipped: 'skipped',
};

/**
 * 跳过必须二分，不能折叠成一个状态（2026-10-30 实测缺陷）：
 *
 * · **降级**（`degraded: true`，工具不可用/引擎缺失）→ `warning`：未检测 ≠ 通过，
 *   必须显形（进警告计数、进 SARIF、进扣分）。这条口径已由 `machine-formatters`
 *   的 `ruleEngineFindings` 立过一次。
 *
 * · **让位**（`degraded: false`，规则自述由其它阶段判定，如后置门禁 health-score /
 *   test-coverage）→ `skipped`：它不是问题，不产 finding、不进「N 项需处理」、
 *   不进「复制到 AI」清单、不扣健康分。
 *
 * 此前两者都映射成 `warning`（并因 `EVAL_SEVERITY_MAP` 里没有 `error` 键而回落
 * `warning` 严重级），后果是 `guard.block.official.health-score` /
 * `guard.block.official.test-coverage` 在门禁页显示为「中危」，被一键复制给 AI
 * 要求「修复」—— 而它们的正文写的是「引擎内不求值」，本就是设计。
 */
function resolveEvalStatus(ev: RuleEvaluation): CheckResult['status'] {
  if (ev.status === 'skipped') return ev.degraded === true ? 'warning' : 'skipped';
  return EVAL_STATUS_MAP[ev.status] ?? 'error';
}

/** 规则严重级 → CheckResult 严重级映射 */
const EVAL_SEVERITY_MAP: Record<string, CheckResult['severity']> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'info',
  info: 'info',
};

/**
 * 传统（非 SOP）路径的警告口径：不是 passed/skipped、且规则严重级为 warning。
 *
 * 与 SOP 路径的 `status === 'warning'` 不是同一件事（后者已是归一化后的落地状态），
 * 故两条路径各自传入谓词，见 `buildReportFromResults`。
 */
const isTraditionalWarning = (r: CheckResult): boolean =>
  r.status !== 'passed' && r.status !== 'skipped' && r.severity === 'warning';

interface GuardBuildReportParams {
  results: CheckResult[];
  options: CheckOptions;
  failedCount: number;
  errorsCount: number;
  warningsCount: number;
  skippedCount: number;
}

export class GuardEngine {
  private configLoader: ConfigLoader;
  private adapterRegistry: AdapterRegistry;
  private normalizer: ResultNormalizer;
  private repoRoot: string;
  private emitter: EventEmitter;
  private sopEngine?: SopRuleEngine;
  /** SOP 重入保护：防止 scanner-dispatch 规则回调 InspectEngine.runScan → 再次 evaluateRules 无限递归 */
  private _sopRunning = false;

  constructor(repoRoot: string, configDir?: string, emitter?: EventEmitter) {
    this.repoRoot = repoRoot;
    this.configLoader = new ConfigLoader(configDir);
    this.adapterRegistry = new AdapterRegistry();
    this.normalizer = new ResultNormalizer();
    this.emitter = emitter ?? NOOP_EMITTER;
  }

  useSopEngine(engine: SopRuleEngine): void {
    this.sopEngine = engine;
  }

  registerAdapter(name: string, adapter: Adapter): void {
    this.adapterRegistry.register(name, adapter);
  }

  filterChecks(checks: CheckConfig[], options: CheckOptions): CheckConfig[] {
    return checks.filter((check) => {
      if (!check.enabled) return false;
      if (check.mode.length > 0 && !check.mode.includes(options.mode)) return false;
      if (options.profile && check.category !== options.profile) return false;
      if (options.checks && options.checks.length > 0 && !options.checks.includes(check.checkId))
        return false;
      return true;
    });
  }

  aggregateReport(results: CheckResult[], options: CheckOptions): GuardReport {
    return this.buildReportFromResults(results, options, isTraditionalWarning);
  }

  async run(options: CheckOptions): Promise<GuardReport> {
    if (this.sopEngine && !this._sopRunning) {
      this._sopRunning = true;
      try {
        return await this.runWithSop(options);
      } finally {
        this._sopRunning = false;
      }
    }
    return this.runTraditional(options);
  }

  private async runTraditional(options: CheckOptions): Promise<GuardReport> {
    const checks = this.loadAndFilterChecks(options);

    const hookStage = options.triggerSource || options.mode;
    await this.emitCheckRequested(hookStage);

    const results = await this.runChecks(checks);
    const report = this.aggregateReport(results, options);
    await this.emitCheckCompleted(report, hookStage);
    return report;
  }

  /** 加载检查配置并按选项过滤，无匹配时抛出错误 */
  private loadAndFilterChecks(options: CheckOptions): CheckConfig[] {
    const allChecks = this.configLoader.loadChecks();
    const checks = this.filterChecks(allChecks, options);
    if (checks.length === 0) {
      throw new Error('no checks matched the current filters');
    }
    return checks;
  }

  /** 依次执行检查并归一化结果（单个检查失败不中断流程） */
  private async runChecks(checks: CheckConfig[]): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const check of checks) {
      try {
        const adapter = this.adapterRegistry.get(check.adapter);
        const ctx = { projectPath: this.repoRoot, repoRoot: this.repoRoot };
        const rawResult = await Promise.resolve(adapter.run(ctx, check));
        results.push(adapter.normalize(rawResult, ctx, check));
      } catch (error) {
        results.push(this.normalizer.fromException(check, error));
      }
    }
    return results;
  }

  private async runWithSop(options: CheckOptions): Promise<GuardReport> {
    const hookStage = options.triggerSource || options.mode;

    await this.emitCheckRequested(hookStage);

    const sopReport = await this.evaluateSopRules(options);
    const results = this.sopReportToResults(sopReport, options);
    const report = this.buildSopReport(results, options);

    await this.emitCheckCompleted(report, hookStage);

    return report;
  }

  /** 执行 SOP 规则引擎评估 */
  private async evaluateSopRules(
    options: CheckOptions,
  ): Promise<Awaited<ReturnType<SopRuleEngine['evaluateRules']>>> {
    const sopEngine = this.sopEngine;
    if (!sopEngine) {
      throw new Error('SOP engine not registered');
    }
    return sopEngine.evaluateRules({
      repoRoot: this.repoRoot,
      domain: 'guard',
      files: undefined,
      dryRun: options.dryRun,
    });
  }

  /** 将 SOP 评估结果按选项过滤并转换为 CheckResult 列表 */
  private sopReportToResults(
    sopReport: Awaited<ReturnType<SopRuleEngine['evaluateRules']>>,
    options: CheckOptions,
  ): CheckResult[] {
    const evaluations = this.filterEvaluations(sopReport.evaluations, options.checks);
    return evaluations.map((ev) => this.evalToCheckResult(ev));
  }

  private async emitCheckRequested(hookStage: string): Promise<void> {
    await this.emitter.emit({
      type: 'guard:check-requested',
      payload: {
        stage: hookStage as GuardStage,
        projectId: this.repoRoot,
        changedFiles: [],
        timestamp: new Date(),
      },
    });
  }

  private async emitCheckCompleted(report: GuardReport, hookStage: string): Promise<void> {
    await this.emitter.emit({
      type: 'guard:check-completed',
      payload: {
        stage: hookStage as GuardStage,
        projectId: this.repoRoot,
        passed: report.ok === true,
        blockedFiles: [],
        issueCount: report.summary.failed + report.summary.errors,
        duration: 0,
        timestamp: new Date(),
      },
    });
  }

  private filterEvaluations(evaluations: RuleEvaluation[], checks?: string[]): RuleEvaluation[] {
    if (!checks || checks.length === 0) return evaluations;

    const wanted = new Set(checks);
    const exact = evaluations.filter(
      (ev) =>
        (ev.rule?.id && wanted.has(ev.rule.id)) || (ev.rule?.name && wanted.has(ev.rule.name)),
    );
    if (exact.length > 0) return exact;

    const wantedArr = [...wanted];
    return evaluations.filter((ev) => {
      const id = (ev.rule?.id || '').toLowerCase();
      const name = (ev.rule?.name || '').toLowerCase();
      return wantedArr.some((c: string) => {
        const key = c.toLowerCase();
        return (
          id.includes(key) ||
          name.includes(key) ||
          (key.includes('lint') && (id.includes('eslint') || name.includes('eslint')))
        );
      });
    });
  }

  private buildSopReport(results: CheckResult[], options: CheckOptions): GuardReport {
    return this.buildReportFromResults(results, options, (r) => r.status === 'warning');
  }

  /**
   * 统计四项计数并组装报告（两条路径共用）。
   *
   * warnings 口径由调用方以谓词注入，不能在此折成一个：传统路径判的是「非
   * passed/skipped 且规则严重级为 warning」，SOP 路径判的是「归一化后的落地状态
   * 就是 warning」，两者对同一批结果给出的数字不同，合并会把 guard 传统检查的
   * 警告计数改错。
   */
  private buildReportFromResults(
    results: CheckResult[],
    options: CheckOptions,
    isWarning: (result: CheckResult) => boolean,
  ): GuardReport {
    return this.buildReport({
      results,
      options,
      failedCount: results.filter((r) => r.status === 'failed').length,
      errorsCount: results.filter((r) => r.status === 'error').length,
      warningsCount: results.filter(isWarning).length,
      skippedCount: results.filter((r) => r.status === 'skipped').length,
    });
  }

  private buildReport(params: GuardBuildReportParams): GuardReport {
    const { results, options, failedCount, errorsCount, warningsCount, skippedCount } = params;
    return {
      contractVersion: 'p0.v1',
      mode: options.mode,
      profile: options.profile || 'all',
      target: options.target || 'repo',
      ok: options.dryRun ? null : failedCount === 0 && errorsCount === 0,
      dryRun: options.dryRun ?? false,
      summary: {
        total: results.length,
        passed: results.filter((r) => r.status === 'passed').length,
        failed: failedCount,
        warnings: warningsCount,
        blocking: results.filter((r) => r.status !== 'passed' && r.blocking).length,
        errors: errorsCount,
        skipped: skippedCount,
      },
      results,
      generatedAt: new Date().toISOString(),
    };
  }

  private evalToCheckResult(ev: RuleEvaluation): CheckResult {
    return {
      checkId: ev.rule?.id || 'unknown',
      adapter: 'sop-engine',
      status: resolveEvalStatus(ev),
      severity: this.resolveEvalSeverity(ev),
      // F1-4：优先消费 kernel 附加的阻断判定；存量/外部评估缺省该字段时回退旧行为（failed 即阻断）
      blocking: ev.blocking ?? ev.status === 'failed',
      message: ev.message || `${ev.status}: ${ev.rule?.name || ev.rule?.id || '未知规则'}`,
      details: ev.violations ? { violations: ev.violations, files: ev.files } : undefined,
      duration: ev.durationMs,
      ...(ev.degraded === true ? { degraded: true } : {}),
    };
  }

  /** 解析评估的严重级：规则严重级映射，缺省回退 warning */
  private resolveEvalSeverity(ev: RuleEvaluation): CheckResult['severity'] {
    return ev.rule ? (EVAL_SEVERITY_MAP[ev.rule.severity] ?? 'warning') : 'warning';
  }
}
