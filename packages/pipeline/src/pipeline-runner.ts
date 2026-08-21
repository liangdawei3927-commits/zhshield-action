/**
 * @module pipeline-runner
 *
 * ## Pipeline Execution Modes
 *
 * This module provides two execution modes for orchestrating code analysis stages:
 *
 * ### 1. checks.json Mode (`PipelineRunner.runFullPipeline`)
 * The full-featured pipeline that runs up to 5 serial stages:
 *   Profile Detection → Guard → [gate] → Inspect → [gate] → Security (resilient) → Scoring (resilient) → Complete
 * - Guard and Inspect are **fail-fast gates**: if either fails, the pipeline returns immediately.
 * - Security and Scoring are **resilient**: failures are logged but do not block downstream stages.
 * - Refactor is excluded from the pipeline (handled separately by the desktop client).
 *
 * ### 2. SOP Rule-Driven Mode (`SopPipelineRunner.runSopDrivenPipeline`)
 * A simplified 2-stage pipeline driven by the SOP rule engine:
 *   SOP Guard → [gate] → SOP Inspect → Complete
 * - Both stages are fail-fast gates.
 * - Delegates to `SopPipelineRunner` internally (accessible via `PipelineRunner.runSopDrivenPipeline`).
 * - No Security, Scoring, or Refactor stages.
 */
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import {
  GuardEngine,
  GuardESLintCheckAdapter,
  GuardSensitiveInfoAdapter,
  FileSecretStateLookup,
  ArchitectureBoundaryAdapter,
  TestRunnerAdapter,
  SecurityScanAdapter,
} from '@zh/guard';
import type { CheckOptions, GuardReport } from '@zh/guard';
import {
  InspectEngine,
  ESLintAdapter,
  TypeScriptAdapter,
  GitleaksAdapter,
  DependencyCruiserAdapter,
  JscpdAdapter,
  TsPruneAdapter,
  SemgrepAdapter,
  DepcheckAdapter,
} from '@zh/inspect';
import type { InspectionReport } from '@zh/inspect';
import { RefactorEngine } from '@zh/refactor';
import type { RefactorReport } from '@zh/refactor';
import { SecurityEngine } from '@zh/security';
import type { SecurityScanReport } from '@zh/security';
import { ScoringEngine, buildHealthDimensions } from '@zh/scoring';
import type { HealthScore } from '@zh/scoring';
import { SopRegistry, SopLoader, EventBus, PluginLoader, Logger, SopRuleEngine } from '@zh/kernel';
import type { Plugin, RuleContext, RuleEngineReport } from '@zh/kernel';
import { createReport, type PipelineReport } from './types';
import { detectProjectProfile, type ProjectProfile } from './project-profile';
import { SopPipelineRunner } from './sop-pipeline-runner';

/** 从 unknown 类型的 catch 错误中安全提取 message */
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type GuardStageResult =
  | { ok: true; report: GuardReport }
  | { ok: false; earlyReturn: PipelineReport };

type InspectStageResult =
  | { ok: true; report: InspectionReport }
  | { ok: false; earlyReturn: PipelineReport };

/**
 * Pipeline orchestration engine — runs Guard → Inspect → Security → Scoring in serial.
 *
 * **Orchestration Model:**
 * - SERIAL execution: each stage completes before the next starts
 * - FAIL-FAST GATE: if Guard or Inspect fails, pipeline returns immediately
 * - RESILIENT FALLBACK: Security and Scoring failures are logged but don't block
 * - NO ROLLBACK: failed stages produce error reports but don't undo previous work
 *
 * **Stage Flow (runFullPipeline):**
 * Profile Detection → Guard → [gate: pass/fail] → Inspect → [gate: pass/fail] → Security (resilient) → Scoring (resilient) → Complete
 *
 * **SOP Rule-Driven Mode** is delegated to {@link SopPipelineRunner} — see {@link runSopDrivenPipeline}.
 */
export class PipelineRunner {
  guardEngine: GuardEngine;
  inspectEngine: InspectEngine;
  securityEngine: SecurityEngine;
  scoringEngine: ScoringEngine;
  repoRoot: string;
  private sopRuleEngine: SopRuleEngine;
  private refactorEngine: RefactorEngine;
  private sopRegistry: SopRegistry;
  private sopLoader: SopLoader;
  private pluginLoader: PluginLoader;
  private eventBus: EventBus;
  private logger: Logger;
  private sopPipelineRunner: SopPipelineRunner;

  constructor(
    repoRoot: string,
    options?: {
      configDir?: string;
    },
  ) {
    this.repoRoot = repoRoot;
    this.logger = new Logger('Pipeline', 'info');

    this.eventBus = new EventBus();
    this.pluginLoader = new PluginLoader();

    // SOP 系统
    this.sopRegistry = new SopRegistry(this.eventBus);

    const defaultRulesDir = __dirname.includes('/dist/')
      ? require('path').resolve(__dirname, '..', '..', 'kernel', 'src', 'sop')
      : require('path').resolve(__dirname, '..', '..', 'kernel', 'src', 'sop');

    const rulesDir = options?.configDir || defaultRulesDir;
    this.sopLoader = new SopLoader(this.sopRegistry, { rulesDir });

    this.guardEngine = new GuardEngine(repoRoot, options?.configDir, {
      emit: (event) => this.eventBus.emit(event.type, event.payload),
    });
    this.inspectEngine = new InspectEngine({
      emit: (event) => this.eventBus.emit(event.type, event.payload),
    });
    this.refactorEngine = new RefactorEngine();
    this.securityEngine = new SecurityEngine({
      emit: (event) => this.eventBus.emit(event.type, event.payload),
    });
    this.scoringEngine = new ScoringEngine();
    this.sopRuleEngine = new SopRuleEngine(this.sopRegistry, {
      eventBus: this.eventBus,
      guardEngine: this.guardEngine,
      inspectEngine: this.inspectEngine,
    });

    // 连线 SOP 引擎：GuardEngine / InspectEngine 注册的适配器自动传播到 SopRuleEngine
    this.guardEngine.useSopEngine(this.sopRuleEngine);
    this.inspectEngine.useSopEngine(this.sopRuleEngine);

    this.sopPipelineRunner = new SopPipelineRunner(repoRoot, this.sopRuleEngine, this.logger);

    this.registerDefaultAdapters();
  }

  private registerDefaultAdapters(): void {
    this.guardEngine.registerAdapter('eslint-check', new GuardESLintCheckAdapter());
    this.guardEngine.registerAdapter('sensitive-info', new GuardSensitiveInfoAdapter(new FileSecretStateLookup()));
    this.guardEngine.registerAdapter('architecture-boundary', new ArchitectureBoundaryAdapter());
    this.guardEngine.registerAdapter('test-runner', new TestRunnerAdapter());
    this.guardEngine.registerAdapter('security-scan', new SecurityScanAdapter());
    // 注册 Inspect ToolAdapter → 经 useSopEngine 连线自动注入 SopRuleEngine
    this.inspectEngine.registerAdapter(new ESLintAdapter(this.repoRoot));
    this.inspectEngine.registerAdapter(new TypeScriptAdapter(this.repoRoot));
    this.inspectEngine.registerAdapter(new GitleaksAdapter());
    this.inspectEngine.registerAdapter(new DependencyCruiserAdapter());
    this.inspectEngine.registerAdapter(new JscpdAdapter());
    this.inspectEngine.registerAdapter(new TsPruneAdapter());
    this.inspectEngine.registerAdapter(new SemgrepAdapter());
    this.inspectEngine.registerAdapter(new DepcheckAdapter());
  }

  async loadPlugin(plugin: Plugin, locale?: LanguageCode): Promise<void> {
    await this.pluginLoader.load(plugin);
    this.logger.info(
      translate('engine.pipeline.log.pluginLoaded', locale ?? DEFAULT_LANGUAGE, {
        name: plugin.name,
        version: plugin.version,
      }),
    );
  }
  async loadSopRules(locale?: LanguageCode): Promise<number> {
    const count = await this.sopLoader.loadFromFileSystem();
    const stats = this.sopRegistry.getStats();
    this.logger.info(
      translate('engine.pipeline.log.sopRulesLoaded', locale ?? DEFAULT_LANGUAGE, {
        count,
        active: stats.byStatus.active || 0,
      }),
    );
    return count;
  }
  async runGuard(options?: Partial<CheckOptions>, locale?: LanguageCode): Promise<GuardReport> {
    this.logger.info(translate('engine.pipeline.log.guardStart', locale ?? DEFAULT_LANGUAGE));

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
      translate('engine.pipeline.log.guardDone', locale ?? DEFAULT_LANGUAGE, {
        passed: report.summary.passed,
        failed: report.summary.failed,
      }),
    );
    return report;
  }
  async runInspect(locale?: LanguageCode): Promise<InspectionReport> {
    this.logger.info(translate('engine.pipeline.log.inspectStart', locale ?? DEFAULT_LANGUAGE));
    const report = await this.inspectEngine.runScan(this.repoRoot, 'full');
    this.logger.info(
      translate('engine.pipeline.log.inspectDone', locale ?? DEFAULT_LANGUAGE, {
        total: report.summary.total,
        error: report.summary.error,
        warning: report.summary.warning,
        info: report.summary.info,
      }),
    );
    return report;
  }
  async runRefactor(locale?: LanguageCode): Promise<RefactorReport> {
    this.logger.info(translate('engine.pipeline.log.refactorStart', locale ?? DEFAULT_LANGUAGE));

    const report = await this.refactorEngine.analyzeDirectory(this.repoRoot);
    this.logger.info(
      translate('engine.pipeline.log.refactorDone', locale ?? DEFAULT_LANGUAGE, {
        totalSmells: report.totalSmells,
        criticalFiles: report.summary.criticalFiles,
      }),
    );
    return report;
  }
  async runProfile(locale?: LanguageCode): Promise<ProjectProfile> {
    this.logger.info(translate('engine.pipeline.log.profileStart', locale ?? DEFAULT_LANGUAGE));
    const profile = detectProjectProfile(this.repoRoot);
    this.logger.info(
      translate('engine.pipeline.log.profileDone', locale ?? DEFAULT_LANGUAGE, {
        language: profile.language,
        framework: profile.framework ? ` / ${profile.framework}` : '',
        packageManager: profile.packageManager,
      }),
    );
    return profile;
  }
  async runSecurity(locale?: LanguageCode): Promise<SecurityScanReport> {
    this.logger.info(translate('engine.pipeline.log.securityStart', locale ?? DEFAULT_LANGUAGE));
    const report = await this.securityEngine.runSecurityScan(this.repoRoot, this.repoRoot);
    this.logger.info(
      translate('engine.pipeline.log.securityDone', locale ?? DEFAULT_LANGUAGE, {
        vulnTotal: report.summary.vulnTotal,
        malwareTotal: report.summary.malwareTotal,
        garbageTotal: report.summary.garbageTotal,
      }),
    );
    return report;
  }
  async runScoring(
    guardReport: GuardReport,
    inspectReport: InspectionReport,
    locale?: LanguageCode,
  ): Promise<HealthScore> {
    this.logger.info(translate('engine.pipeline.log.scoringStart', locale ?? DEFAULT_LANGUAGE));
    const dimensions = buildHealthDimensions(guardReport, inspectReport);
    const score = this.scoringEngine.calculate(this.repoRoot, dimensions);
    this.logger.info(
      translate('engine.pipeline.log.scoringDone', locale ?? DEFAULT_LANGUAGE, {
        overall: score.overall,
        grade: score.grade,
      }),
    );
    return score;
  }
  // ─── SOP 规则驱动模式（委托 SopPipelineRunner） ───
  async runSopGuard(context?: Partial<RuleContext>, locale?: LanguageCode): Promise<RuleEngineReport> {
    return this.sopPipelineRunner.runSopGuard(context, locale);
  }

  async runSopInspect(context?: Partial<RuleContext>, locale?: LanguageCode): Promise<RuleEngineReport> {
    return this.sopPipelineRunner.runSopInspect(context, locale);
  }

  async runSopDrivenPipeline(options?: {
    guardContext?: Partial<RuleContext>;
    inspectContext?: Partial<RuleContext>;
  }, locale?: LanguageCode): Promise<PipelineReport> {
    return this.sopPipelineRunner.runSopDrivenPipeline(options, locale);
  }

  // ─── checks.json 模式 ───

  async runFullPipeline(options?: Partial<CheckOptions>, locale?: LanguageCode): Promise<PipelineReport> {
    this.logger.info(translate('engine.pipeline.log.pipelineStart', locale ?? DEFAULT_LANGUAGE));

    const profile = await this.runProfile(locale).catch(() => null);

    const guardStage = await this.runGuardStage(options, locale);
    if (!guardStage.ok) return { ...guardStage.earlyReturn, profile };

    this.logger.info(translate('engine.pipeline.log.guardPassedToInspect', locale ?? DEFAULT_LANGUAGE));
    const inspectStage = await this.runInspectStage(guardStage.report, locale);
    if (!inspectStage.ok) return { ...inspectStage.earlyReturn, profile };

    const security = await this.runSecurity(locale).catch((error) => {
      this.logger.error(
        translate('engine.pipeline.log.securityFailed', locale ?? DEFAULT_LANGUAGE, { error: toMessage(error) }),
      );
      return null;
    });

    const score = await this.runScoring(guardStage.report, inspectStage.report, locale).catch(() => null);

    // 重构由独立入口 runRefactor() / 桌面重构页负责
    this.logger.info(translate('engine.pipeline.log.pipelineDone', locale ?? DEFAULT_LANGUAGE));
    return createReport({
      guard: guardStage.report,
      inspect: inspectStage.report,
      profile,
      security,
      score,
      passed: true,
      stage: 'complete',
    });
  }

  private async runGuardStage(
    options?: Partial<CheckOptions>,
    locale?: LanguageCode,
  ): Promise<GuardStageResult> {
    let guardReport: GuardReport | null = null;
    try {
      guardReport = await this.runGuard(
        {
          ...options,
          mode: 'guard',
        },
        locale,
      );
    } catch (error) {
      this.logger.error(
        translate('engine.pipeline.log.guardCheckFailed', locale ?? DEFAULT_LANGUAGE, { error: toMessage(error) }),
      );
      return {
        ok: false,
        earlyReturn: createReport({
          stage: 'guard',
          passed: false,
          error: toMessage(error),
        }),
      };
    }

    if (guardReport.ok === false) {
      this.logger.warn(
        translate('engine.pipeline.log.guardBlocked', locale ?? DEFAULT_LANGUAGE, {
          failed: guardReport.summary.failed,
        }),
      );
      return {
        ok: false,
        earlyReturn: createReport({
          guard: guardReport,
          stage: 'guard',
          passed: false,
        }),
      };
    }

    return { ok: true, report: guardReport };
  }

  private async runInspectStage(
    guardReport: GuardReport,
    locale?: LanguageCode,
  ): Promise<InspectStageResult> {
    try {
      const inspectReport = await this.runInspect(locale);
      return { ok: true, report: inspectReport };
    } catch (error) {
      this.logger.error(
        translate('engine.pipeline.log.inspectFailed', locale ?? DEFAULT_LANGUAGE, { error: toMessage(error) }),
      );
      return {
        ok: false,
        earlyReturn: createReport({
          guard: guardReport,
          stage: 'inspect',
          passed: false,
          error: toMessage(error),
        }),
      };
    }
  }

  async destroy(locale?: LanguageCode): Promise<void> {
    await this.pluginLoader.unloadAll();
    this.eventBus.removeAllListeners();
    this.guardEngine = null!;
    this.inspectEngine = null!;
    this.securityEngine = null!;
    this.scoringEngine = null!;
    this.logger.info(translate('engine.pipeline.log.pipelineClosed', locale ?? DEFAULT_LANGUAGE));
  }
}
