import {
  GuardEngine,
  GuardESLintCheckAdapter,
  GuardSensitiveInfoAdapter,
  ArchitectureBoundaryAdapter,
  TestRunnerAdapter,
  SecurityScanAdapter,
  GuardTrivyAdapter,
} from '@zh/guard';
import type { CheckOptions, GuardReport } from '@zh/guard';
import {
  InspectEngine,
  ESLintAdapter,
  GitleaksAdapter,
  DependencyCruiserAdapter,
  JscpdAdapter,
  TsPruneAdapter,
  SemgrepAdapter,
  DepcheckAdapter,
  TypeScriptAdapter,
  PrettierAdapter,
  CommitLintAdapter,
  NpmAuditAdapter,
} from '@zh/inspect';
import type { InspectionReport } from '@zh/inspect';
import { RefactorEngine } from '@zh/refactor';
import type { RefactorReport } from '@zh/refactor';
import { createRuleMetricsProvider } from './rule-metrics';
import { createGateMetricResolver } from './gate-metrics';
import type { GateMetricInputs } from './gate-metrics';
import { SecurityCheckEngine, TrivyAdapter } from '@zh/security';
import { SopRegistry, SopLoader, EventBus, PluginLoader, Logger, SopRuleEngine, evaluatePostScanGates } from '@zh/kernel';
import type { Plugin, RuleContext, RuleEngineReport, PostScanGateReport } from '@zh/kernel';
import { EventCenter, subscribeScopeViolations } from '@zh/sentinel';
import {
  loadBaseline,
  filterIssuesByBaseline,
  loadRefactorBaseline,
  type Baseline,
} from '@zh/shared';
import { applyRefactorBaseline } from '@zh/refactor';
import type { PipelineReport } from './types';
import { registerAutoPerfAdapter } from './autoperf-adapter';
import { SonarwayToolAdapter } from './sonarway-tool-adapter';
import { toMessage } from './runner-utils';
import { buildSuccessReport } from './report-builders';
import { resolveEffectiveProjectRoot } from './project-profile';
import { resolveDefaultSopRulesDir } from './sop-rules-dir';
import { loadBundledSopRules, loadSopRulesFromSyncCache } from './sop-rule-loading';
import {
  composeRuleContext,
  deriveProjectFeature,
  logTrimObservability,
  runGuardPhase,
  runInspectPhase,
  runSopGuardPhase,
  runSopInspectPhase,
} from './pipeline-runner-phase-helpers';

export { toMessage };

/** 默认适配器注册表 — 纯模块级装配函数，不依赖 PipelineRunner 实例状态。
 *  Guard 适配器走自身 registerAdapter；Inspect ToolAdapter 经 useSopEngine
 *  连线自动注入 SopRuleEngine。AutoPerf 性能自治引擎 fail-soft 注册。 */
async function registerDefaultAdapters(
  guardEngine: GuardEngine,
  inspectEngine: InspectEngine,
): Promise<void> {
  guardEngine.registerAdapter('eslint-check', new GuardESLintCheckAdapter());
  guardEngine.registerAdapter('sensitive-info', new GuardSensitiveInfoAdapter());
  guardEngine.registerAdapter('architecture-boundary', new ArchitectureBoundaryAdapter());
  guardEngine.registerAdapter('test-runner', new TestRunnerAdapter());
  guardEngine.registerAdapter('security-scan', new SecurityScanAdapter());
  guardEngine.registerAdapter('trivy', new GuardTrivyAdapter());
  inspectEngine.registerAdapter(new ESLintAdapter());
  inspectEngine.registerAdapter(new GitleaksAdapter());
  inspectEngine.registerAdapter(new DependencyCruiserAdapter());
  inspectEngine.registerAdapter(new JscpdAdapter());
  inspectEngine.registerAdapter(new TsPruneAdapter());
  inspectEngine.registerAdapter(new SemgrepAdapter());
  inspectEngine.registerAdapter(new DepcheckAdapter());
  inspectEngine.registerAdapter(new TypeScriptAdapter());
  inspectEngine.registerAdapter(new PrettierAdapter());
  inspectEngine.registerAdapter(new CommitLintAdapter());
  inspectEngine.registerAdapter(new NpmAuditAdapter());
  inspectEngine.registerAdapter(new SonarwayToolAdapter());
  inspectEngine.registerAdapter(new TrivyAdapter());
  await registerAutoPerfAdapter(inspectEngine);
}

/**
 * SOP 巡检报告基线豁免：对 RuleEngineReport 的每条评估按其 violations 命中
 * .zhshield/baseline.json 过滤基线键（ruleId:file:line:column）。
 *
 * 语义对齐 InspectEngine.reconcileAdapterResults：
 * - 未设置基线 / 基线为空 / 无命中 → 原样返回报告（零行为回归）；
 * - 命中但仅部分豁免 → 保留未豁免的 violations，状态不变；
 * - 全部豁免且原状态为 failed → 置为 passed（避免"0 违规但规则失败"的矛盾）。
 *
 * 豁免后重算 passed/failed/errors/skipped/degraded/blockingCount/ok，
 * 使报告计数与 evaluations 内容一致（复用 kernel aggregate 的口径）。
 */
function applyBaselineToSopReport(
  report: RuleEngineReport,
  baseline: Baseline | null,
  projectRoot: string,
): RuleEngineReport {
  if (!baseline || baseline.entries.length === 0) return report;

  const evaluations = report.evaluations.map((ev) => {
    const violations = ev.violations ?? [];
    if (violations.length === 0) return ev;
    const { kept, suppressed } = filterIssuesByBaseline(violations, baseline, projectRoot);
    if (suppressed > 0) {
      const fullySuppressed = kept.length === 0;
      return {
        ...ev,
        violations: kept,
        status: fullySuppressed && ev.status === 'failed' ? ('passed' as const) : ev.status,
        blocking: fullySuppressed ? false : ev.blocking,
      };
    }
    return ev;
  });

  const passed = evaluations.filter((e) => e.status === 'passed').length;
  const failed = evaluations.filter((e) => e.status === 'failed').length;
  const errors = evaluations.filter((e) => e.status === 'error').length;
  const skipped = evaluations.filter((e) => e.status === 'skipped').length;
  const degraded = evaluations.filter((e) => e.degraded === true).length;
  const blockingCount = evaluations.filter((e) => e.blocking === true).length;

  return {
    ...report,
    passed,
    failed,
    errors,
    skipped,
    degraded,
    blockingCount,
    ok: failed === 0 && errors === 0 && degraded === 0,
    evaluations,
  };
}

export class PipelineRunner {
  guardEngine: GuardEngine;
  inspectEngine: InspectEngine;
  private securityCheckEngine: SecurityCheckEngine;
  repoRoot: string;
  private sopRuleEngine: SopRuleEngine;
  private refactorEngine: RefactorEngine;
  private sopRegistry: SopRegistry;
  private sopLoader: SopLoader;
  private pluginLoader: PluginLoader;
  private eventBus: EventBus;
  private eventCenter: EventCenter;
  private logger: Logger;
  private readonly sopRulesDir: string;

  constructor(
    repoRoot: string,
    options?: {
      configDir?: string;
    },
  ) {
    // 归一化 repoRoot 为绝对路径：相对路径会原样流入 SOP tool-dispatch 的
    // ToolScanOptions.projectPath，外部工具（semgrep/gitleaks 等）以自身 cwd 解析导致
    // "no such file" / "unable to find a config"。共享构造缝统一 resolve，下游全部拿到绝对路径。
    // 容器目录下探：目标无 package.json 且存在唯一嵌套仓库根时解析为该根，
    // 使画像裁剪（toolScope）与工具适配器（depcheck 等）不被容器路径误跳过。
    this.repoRoot = resolveEffectiveProjectRoot(repoRoot);
    this.logger = new Logger('Pipeline', 'info');

    this.eventBus = new EventBus();
    this.eventCenter = new EventCenter();
    subscribeScopeViolations(this.eventBus, this.eventCenter);
    this.pluginLoader = new PluginLoader();

    // SOP 系统
    this.sopRegistry = new SopRegistry(this.eventBus);

    // SOP 规则目录：内置规则模板解析已提取至 sop-rules-dir.ts（单一来源）
    this.sopRulesDir = options?.configDir || resolveDefaultSopRulesDir();
    this.sopLoader = new SopLoader(this.sopRegistry, { rulesDir: this.sopRulesDir });

    this.guardEngine = new GuardEngine(this.repoRoot, options?.configDir, {
      emit: (event) => this.eventBus.emit(event.type, event.payload),
    });
    this.inspectEngine = new InspectEngine({
      emit: (event) => this.eventBus.emit(event.type, event.payload),
    });
    this.refactorEngine = new RefactorEngine();
    this.securityCheckEngine = new SecurityCheckEngine();
    this.sopRuleEngine = new SopRuleEngine(this.sopRegistry, {
      eventBus: this.eventBus,
      guardEngine: this.guardEngine,
      inspectEngine: this.inspectEngine,
      securityCheckEngine: this.securityCheckEngine,
      // 阈值指令的实测值来源。缺了它，threshold 规则只会在报告里落「降级」——
      // 2026-10-29 前更糟：恒判 passed（面板显示通过、实际零比较）。
      metricsProvider: createRuleMetricsProvider(this.repoRoot),
    });

    // 连线 SOP 引擎：GuardEngine / InspectEngine 注册的适配器自动传播到 SopRuleEngine
    this.guardEngine.useSopEngine(this.sopRuleEngine);
    this.inspectEngine.useSopEngine(this.sopRuleEngine);

    void registerDefaultAdapters(this.guardEngine, this.inspectEngine);
  }

  async loadPlugin(plugin: Plugin): Promise<void> {
    await this.pluginLoader.load(plugin);
    this.logger.info(`插件已加载: ${plugin.name}@${plugin.version}`);
  }
  async loadSopRules(): Promise<number> {
    return loadBundledSopRules({
      loader: this.sopLoader,
      registry: this.sopRegistry,
      logger: this.logger,
      rulesDir: this.sopRulesDir,
    });
  }

  /** 合并云同步缓存规则（`{cacheDir}/modules/*.db`）；目录不可用返回 0 */
  async loadSopRulesFromCache(cacheDir: string): Promise<number> {
    return loadSopRulesFromSyncCache(
      { loader: this.sopLoader, registry: this.sopRegistry, logger: this.logger },
      cacheDir,
    );
  }

  async runGuard(options?: Partial<CheckOptions>): Promise<GuardReport> {
    this.logger.info('开始 Guard 门禁检查...');

    const opts: CheckOptions = {
      mode: options?.mode || 'guard',
      profile: options?.profile,
      checks: options?.checks,
      format: 'json',
      target: this.repoRoot,
      dryRun: options?.dryRun ?? false,
      ...options,
    };

    const report = await this.guardEngine.run(opts);
    this.logger.info(
      `Guard 检查完成: ${report.summary.passed} passed, ${report.summary.failed} failed`,
    );
    return report;
  }
  async runInspect(options?: { skipBaseline?: boolean }): Promise<InspectionReport> {
    this.logger.info('开始 Inspect 引擎巡检...');
    // R3d 执行面投影激活：直扫按画像裁剪 — 复用既有 deriveProjectFeature（M2 同源探测），
    // 探测失败 → undefined → 不裁剪（与现状行为一致，回归安全）。
    const feature = deriveProjectFeature(this.repoRoot);
    const baseline = options?.skipBaseline ? null : await loadBaseline(this.repoRoot);
    const report = await this.inspectEngine.runScan(this.repoRoot, 'full', feature, baseline);
    const suppressedNote =
      report.suppressedCount && report.suppressedCount > 0
        ? `（基线豁免 ${report.suppressedCount} 项）`
        : '';
    this.logger.info(
      `巡检完成: ${report.summary.total} 个问题 (${report.summary.error} error, ${report.summary.warning} warning, ${report.summary.info} info)${suppressedNote}`,
    );
    return report;
  }
  async runRefactor(options?: { skipBaseline?: boolean }): Promise<RefactorReport> {
    this.logger.info('开始 Refactor 重构检测...');

    const report = await this.refactorEngine.analyzeDirectory(this.repoRoot);
    if (options?.skipBaseline) {
      this.logger.info(
        `重构检测完成: ${report.totalSmells} 处异味 (${report.summary.criticalFiles} 个文件需要关注)`,
      );
      return report;
    }
    // 棘轮基线：.zhshield/refactor-baseline.json 存在时只报增量（存量压制）；
    // 无基线时原样返回全量报告，行为与历史版本一致（零回归）。
    const baselineCounts = await loadRefactorBaseline(this.repoRoot);
    if (!baselineCounts) {
      this.logger.info(
        `重构检测完成: ${report.totalSmells} 处异味 (${report.summary.criticalFiles} 个文件需要关注)`,
      );
      return report;
    }
    const filtered = applyRefactorBaseline(report, baselineCounts, this.repoRoot);
    const note =
      filtered.suppressedCount > 0 ? `（基线豁免 ${filtered.suppressedCount} 项存量）` : '';
    this.logger.info(
      `重构检测完成: ${filtered.report.totalSmells} 处异味 (${filtered.report.summary.criticalFiles} 个文件需要关注)${note}`,
    );
    return filtered.report;
  }
  // ─── SOP 规则驱动模式 ───
  async runSopGuard(context?: Partial<RuleContext>): Promise<RuleEngineReport> {
    this.logger.info('开始 SOP 驱动型 Guard 门禁检查...');
    const report = await this.sopRuleEngine.runGuard(
      composeRuleContext(this.repoRoot, 'guard', context),
    );
    this.logger.info(
      `SOP Guard 检查完成: ${report.passed} passed, ${report.failed} failed, ${report.errors} errors`,
    );
    return report;
  }

  async runSopInspect(
    context?: Partial<RuleContext>,
    options?: { skipBaseline?: boolean },
  ): Promise<RuleEngineReport> {
    this.logger.info('开始 SOP 驱动型 Inspect 巡检...');
    const report = await this.sopRuleEngine.runInspect(
      composeRuleContext(this.repoRoot, 'inspect', context),
    );
    if (options?.skipBaseline) return report;
    // R3d(b) 链路对齐：SOP 巡检报告同样消费 .zhshield/baseline.json 基线豁免
    // （与 runInspect 直扫链路一致；无基线时原样返回，零回归）。
    const baseline = await loadBaseline(this.repoRoot);
    const filtered = applyBaselineToSopReport(report, baseline, this.repoRoot);
    const rawViolations = report.evaluations.reduce((n, ev) => n + (ev.violations?.length ?? 0), 0);
    const keptViolations = filtered.evaluations.reduce((n, ev) => n + (ev.violations?.length ?? 0), 0);
    const suppressedNote = keptViolations < rawViolations ? `（基线豁免 ${rawViolations - keptViolations} 项）` : '';
    this.logger.info(
      `SOP Inspect 完成: ${filtered.passed} passed, ${filtered.failed} failed, ${filtered.skipped} skipped${suppressedNote}`,
    );
    return filtered;
  }

  async runSopDrivenPipeline(options?: {
    guardContext?: Partial<RuleContext>;
    inspectContext?: Partial<RuleContext>;
  }): Promise<PipelineReport> {
    this.logger.info('========== SOP 驱动型全流水线开始 ==========');
    const guardContext = composeRuleContext(this.repoRoot, 'guard', options?.guardContext);
    const inspectContext = composeRuleContext(this.repoRoot, 'inspect', options?.inspectContext);

    const guardStage = await this.runSopGuardStage(guardContext);
    if ('failure' in guardStage) return guardStage.failure;
    const guardReport = guardStage.report;

    this.logger.info('SOP Guard 通过, 进入 SOP Inspect 巡检阶段...');
    const inspectStage = await this.runSopInspectStage(inspectContext, guardReport);
    if ('failure' in inspectStage) return inspectStage.failure;
    const inspectReport = inspectStage.report;

    return this.finishSopPipeline(guardReport, inspectReport);
  }

  private async runSopGuardStage(
    guardContext: Partial<RuleContext>,
  ): Promise<{ report: RuleEngineReport } | { failure: PipelineReport }> {
    const guardPhase = await runSopGuardPhase(
      this.logger,
      (ctx) => this.runSopGuard(ctx),
      guardContext,
    );
    if ('failure' in guardPhase) {
      return { failure: guardPhase.failure };
    }
    return { report: guardPhase.report };
  }

  private async runSopInspectStage(
    inspectContext: Partial<RuleContext> | undefined,
    guardReport: RuleEngineReport,
  ): Promise<{ report: RuleEngineReport } | { failure: PipelineReport }> {
    const inspectPhase = await runSopInspectPhase(
      this.logger,
      (ctx) => this.runSopInspect(ctx),
      inspectContext,
      guardReport,
    );
    if ('failure' in inspectPhase) {
      return { failure: inspectPhase.failure };
    }
    return { report: inspectPhase.report };
  }

  private finishSopPipeline(
    guardReport: RuleEngineReport,
    inspectReport: RuleEngineReport,
  ): PipelineReport {
    logTrimObservability(this.logger, guardReport, 'Guard');
    logTrimObservability(this.logger, inspectReport, 'Inspect');
    this.logger.info('========== SOP 驱动型全流水线完成（不含重构） ==========');
    return buildSuccessReport(guardReport, inspectReport);
  }

  // ─── checks.json 模式 ───

  async runFullPipeline(options?: Partial<CheckOptions>): Promise<PipelineReport> {
    this.logger.info('========== 智汇码盾全流水线开始 ==========');

    const guardPhase = await runGuardPhase(this.logger, (opts) => this.runGuard(opts), options);
    if ('failure' in guardPhase) {
      return guardPhase.failure;
    }
    const guardReport = guardPhase.report;

    this.logger.info('Guard 通过, 进入 Inspect 巡检阶段...');
    const inspectPhase = await runInspectPhase(this.logger, () => this.runInspect(), guardReport);
    if ('failure' in inspectPhase) {
      return inspectPhase.failure;
    }
    const inspectReport = inspectPhase.report;

    this.logger.info('========== 智汇码盾全流水线完成（不含重构） ==========');
    return buildSuccessReport(guardReport, inspectReport);
  }

  /**
   * 扫描后门禁判定（健康分 / 质量分 / 覆盖率）。
   *
   * 为什么不在 `runSop*` 里顺手做：这三项的数据源是**整轮扫描结束后**才存在的
   * （`@zh/scoring` 的聚合分、测试产出的 coverage-summary.json）。规则引擎在扫描
   * 过程中求值，拿不到；硬判只会变成「每次都降级」。故拆成独立阶段，由调用方
   * 在扫描完成后调用一次 —— CLI 在命令结束后调，桌面端在评分阶段调。
   *
   * @param inputs 调用方已知的聚合值（桌面端传评分与覆盖率）；缺项落 undetermined
   */
  evaluatePostScanGates(inputs?: GateMetricInputs): PostScanGateReport {
    return evaluatePostScanGates(
      this.sopRegistry.getAll(),
      createGateMetricResolver(this.repoRoot, inputs),
    );
  }

  async destroy(): Promise<void> {
    await this.pluginLoader.unloadAll();
    this.eventBus.removeAllListeners();
    this.guardEngine = null!;
    this.inspectEngine = null!;
    this.logger.info('流水线已关闭');
  }
}
