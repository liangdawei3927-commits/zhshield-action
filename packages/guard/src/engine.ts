import type { CheckOptions, CheckResult, CheckConfig, GuardReport, Adapter } from './types';
import type { EventEmitter, GuardStage } from '@zh/shared';
import type { SopRuleEngine, RuleEvaluation } from '@zh/kernel';
import { NOOP_EMITTER } from '@zh/shared';
import { ConfigLoader } from './config-loader';
import { AdapterRegistry } from './adapter-registry';
import { ResultNormalizer } from './result-normalizer';

/** buildReport 参数对象 */
interface BuildReportParams {
  results: CheckResult[];
  options: CheckOptions;
  failedCount: number;
  errorsCount: number;
  warningsCount: number;
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
      if (options.checks && options.checks.length > 0 && !options.checks.includes(check.checkId)) return false;
      return true;
    });
  }

  aggregateReport(results: CheckResult[], options: CheckOptions): GuardReport {
    const failed = results.filter((r) => r.status === 'failed');
    const errors = results.filter((r) => r.status === 'error');
    const warnings = results.filter((r) => r.status !== 'passed' && r.severity === 'warning').length;

    return this.buildReport({ results, options, failedCount: failed.length, errorsCount: errors.length, warningsCount: warnings });
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
        const rawResult = await Promise.resolve(adapter.run({}, check));
        results.push(adapter.normalize(rawResult, {}, check));
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
  private async evaluateSopRules(options: CheckOptions): Promise<Awaited<ReturnType<SopRuleEngine['evaluateRules']>>> {
    return this.sopEngine!.evaluateRules({
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
        (ev.rule?.id && wanted.has(ev.rule.id)) ||
        (ev.rule?.name && wanted.has(ev.rule.name)),
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
    const failed = results.filter((r) => r.status === 'failed');
    const errors = results.filter((r) => r.status === 'error');
    const warnings = results.filter((r) => r.status === 'warning').length;

    return this.buildReport({ results, options, failedCount: failed.length, errorsCount: errors.length, warningsCount: warnings });
  }

  private buildReport(params: BuildReportParams): GuardReport {
    const { results, options, failedCount, errorsCount, warningsCount } = params;
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
      },
      results,
      generatedAt: new Date().toISOString(),
    };
  }

  private evalToCheckResult(ev: RuleEvaluation): CheckResult {
    const statusMap: Record<string, CheckResult['status']> = {
      passed: 'passed',
      failed: 'failed',
      error: 'error',
      skipped: 'warning',
    };

    const severityMap: Record<string, CheckResult['severity']> = {
      critical: 'error',
      high: 'error',
      medium: 'warning',
      low: 'info',
      info: 'info',
    };

    const severity = ev.rule
      ? severityMap[ev.rule.severity] ?? 'warning'
      : 'warning';

    return {
      checkId: ev.rule?.id || 'unknown',
      adapter: 'sop-engine',
      status: statusMap[ev.status] ?? 'error',
      severity,
      blocking: ev.status === 'failed',
      message: ev.message || `${ev.status}: ${ev.rule?.name || ev.rule?.id || '未知规则'}`,
      details: ev.violations
        ? { violations: ev.violations, files: ev.files }
        : undefined,
      duration: ev.durationMs,
    };
  }
}
