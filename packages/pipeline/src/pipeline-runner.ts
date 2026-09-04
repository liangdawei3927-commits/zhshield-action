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
import { SopRegistry, SopLoader, EventBus, PluginLoader, Logger, SopRuleEngine } from '@zh/kernel';
import type { Plugin, RuleContext, RuleEngineReport, ProjectFeature } from '@zh/kernel';
import { EventCenter, subscribeScopeViolations } from '@zh/sentinel';
import type { PipelineReport } from './types';
import { registerAutoPerfAdapter } from './autoperf-adapter';
import { SonarwayToolAdapter } from './sonarway-tool-adapter';
import { detectProjectProfile } from './project-profile';
import { toFeatureFromProfile } from '@zh/fingerprint';
import { toMessage } from './runner-utils';
import { buildFailureReport, buildSuccessReport } from './report-builders';

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
  await registerAutoPerfAdapter(inspectEngine);
}

export class PipelineRunner {
  guardEngine: GuardEngine;
  inspectEngine: InspectEngine;
  repoRoot: string;
  private sopRuleEngine: SopRuleEngine;
  private refactorEngine: RefactorEngine;
  private sopRegistry: SopRegistry;
  private sopLoader: SopLoader;
  private pluginLoader: PluginLoader;
  private eventBus: EventBus;
  private eventCenter: EventCenter;
  private logger: Logger;

  constructor(
    repoRoot: string,
    options?: {
      configDir?: string;
    },
  ) {
    this.repoRoot = repoRoot;
    this.logger = new Logger('Pipeline', 'info');

    this.eventBus = new EventBus();
    this.eventCenter = new EventCenter();
    subscribeScopeViolations(this.eventBus, this.eventCenter);
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
    this.sopRuleEngine = new SopRuleEngine(this.sopRegistry, {
      eventBus: this.eventBus,
      guardEngine: this.guardEngine,
      inspectEngine: this.inspectEngine,
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
    const count = await this.sopLoader.loadFromFileSystem();
    const stats = this.sopRegistry.getStats();
    this.logger.info(`SOP 规则已加载: ${count} 条 (活跃: ${stats.byStatus.active || 0})`);
    return count;
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
  async runInspect(): Promise<InspectionReport> {
    this.logger.info('开始 Inspect 引擎巡检...');
    const report = await this.inspectEngine.runScan(this.repoRoot, 'full');
    this.logger.info(
      `巡检完成: ${report.summary.total} 个问题 (${report.summary.error} error, ${report.summary.warning} warning, ${report.summary.info} info)`,
    );
    return report;
  }
  async runRefactor(): Promise<RefactorReport> {
    this.logger.info('开始 Refactor 重构检测...');

    const report = await this.refactorEngine.analyzeDirectory(this.repoRoot);
    this.logger.info(
      `重构检测完成: ${report.totalSmells} 处异味 (${report.summary.criticalFiles} 个文件需要关注)`,
    );
    return report;
  }
  // ─── SOP 规则驱动模式 ───
  async runSopGuard(context?: Partial<RuleContext>): Promise<RuleEngineReport> {
    this.logger.info('开始 SOP 驱动型 Guard 门禁检查...');
    const report = await this.sopRuleEngine.runGuard(this.composeContext('guard', context));
    this.logger.info(
      `SOP Guard 检查完成: ${report.passed} passed, ${report.failed} failed, ${report.errors} errors`,
    );
    return report;
  }

  async runSopInspect(context?: Partial<RuleContext>): Promise<RuleEngineReport> {
    this.logger.info('开始 SOP 驱动型 Inspect 巡检...');
    const report = await this.sopRuleEngine.runInspect(this.composeContext('inspect', context));
    this.logger.info(
      `SOP Inspect 完成: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`,
    );
    return report;
  }

  async runSopDrivenPipeline(options?: {
    guardContext?: Partial<RuleContext>;
    inspectContext?: Partial<RuleContext>;
  }): Promise<PipelineReport> {
    this.logger.info('========== SOP 驱动型全流水线开始 ==========');

    const guardContext = this.composeContext('guard', options?.guardContext);
    const inspectContext = this.composeContext('inspect', options?.inspectContext);

    const guardPhase = await this.runSopGuardPhase(guardContext);
    if ('failure' in guardPhase) {
      return guardPhase.failure;
    }
    const guardReport = guardPhase.report;

    this.logger.info('SOP Guard 通过, 进入 SOP Inspect 巡检阶段...');
    const inspectPhase = await this.runSopInspectPhase(inspectContext, guardReport);
    if ('failure' in inspectPhase) {
      return inspectPhase.failure;
    }
    const inspectReport = inspectPhase.report;

    this.logTrimObservability(guardReport, 'Guard');
    this.logTrimObservability(inspectReport, 'Inspect');

    this.logger.info('========== SOP 驱动型全流水线完成（不含重构） ==========');
    return buildSuccessReport(guardReport, inspectReport);
  }

  /**
   * 组装引擎所需 context：叠加 repoRoot + 阶段 domain，并在调用方未显式给定
   * projectFeature 时按画像自动注入（M2）。画像探测异常 → undefined → 引擎回退
   * 为不按画像过滤的全量规则评估（安全行为）。
   */
  private composeContext(domain: 'guard' | 'inspect', partial?: Partial<RuleContext>): RuleContext {
    const base = {
      dryRun: domain === 'guard' ? (partial?.dryRun ?? false) : partial?.dryRun,
      ...partial,
      repoRoot: this.repoRoot,
    } satisfies RuleContext;
    if (!base.projectFeature) {
      const feature = this.deriveProjectFeature();
      if (feature) base.projectFeature = feature;
    }
    return base;
  }

  /**
   * 输出按画像裁剪观测：active=预裁剪活跃规则数，hit=命中后实际评估数，
   * 差值即画像驱动裁剪削减量（验证加载链路裁剪效果）。
   */
  private logTrimObservability(report: RuleEngineReport, phase: string): void {
    const trim = report.profileTrim;
    if (!trim) {
      this.logger.info(`[${phase}] 未启用画像裁剪观测（无 projectFeature，全量评估）`);
      return;
    }
    const trimmed = trim.active - trim.hit;
    this.logger.info(
      `[${phase}] 画像裁剪观测: 活跃 ${trim.active} 条 → 命中 ${trim.hit} 条 (削减 ${trimmed} 条, ${Math.round((trimmed / trim.active) * 100)}%)`,
    );
  }

  /**
   * 从本项目既有的 detectProjectProfile 探测结果派生 kernel 兼容的 ProjectFeature。
   * 投影委托给 fingerprint 的 toFeatureFromProfile（§11.1 投影资产，唯一投影家），
   * 本处仅保留探测调用与异常降级。失败/未知时返回 undefined（退化为不按画像过滤的安全行为）。
   */
  private deriveProjectFeature(): ProjectFeature | undefined {
    try {
      const profile = detectProjectProfile(this.repoRoot);
      return toFeatureFromProfile(profile);
    } catch {
      // 画像探测异常不影响体检主流程，退化为不按画像过滤（全量规则）的既有行为。
      return undefined;
    }
  }

  /** 执行 SOP Guard 阶段：捕获异常并检查阻断，返回报告或失败报告 */
  private async runSopGuardPhase(
    guardContext?: Partial<RuleContext>,
  ): Promise<{ report: RuleEngineReport } | { failure: PipelineReport }> {
    try {
      const report = await this.runSopGuard(guardContext);
      if (!report.ok) {
        this.logger.warn(`SOP Guard 阻断, 流水线终止 (${report.failed} 项失败)`);
        return { failure: buildFailureReport('guard', report, null) };
      }
      return { report };
    } catch (error) {
      this.logger.error(`SOP Guard 检查失败: ${toMessage(error)}`);
      return { failure: buildFailureReport('guard', null, null, toMessage(error)) };
    }
  }

  /** 执行 SOP Inspect 阶段：捕获异常并返回报告或失败报告 */
  private async runSopInspectPhase(
    inspectContext: Partial<RuleContext> | undefined,
    guardReport: RuleEngineReport,
  ): Promise<{ report: RuleEngineReport } | { failure: PipelineReport }> {
    try {
      const report = await this.runSopInspect(inspectContext);
      return { report };
    } catch (error) {
      this.logger.error(`SOP Inspect 巡检失败: ${toMessage(error)}`);
      return { failure: buildFailureReport('inspect', guardReport, null, toMessage(error)) };
    }
  }

  // ─── checks.json 模式 ───

  async runFullPipeline(options?: Partial<CheckOptions>): Promise<PipelineReport> {
    this.logger.info('========== 智汇码盾全流水线开始 ==========');

    const guardPhase = await this.runGuardPhase(options);
    if ('failure' in guardPhase) {
      return guardPhase.failure;
    }
    const guardReport = guardPhase.report;

    this.logger.info('Guard 通过, 进入 Inspect 巡检阶段...');
    const inspectPhase = await this.runInspectPhase(guardReport);
    if ('failure' in inspectPhase) {
      return inspectPhase.failure;
    }
    const inspectReport = inspectPhase.report;

    this.logger.info('========== 智汇码盾全流水线完成（不含重构） ==========');
    return buildSuccessReport(guardReport, inspectReport);
  }

  /** 执行 Guard 阶段：捕获异常并检查阻断，返回报告或失败报告 */
  private async runGuardPhase(
    options?: Partial<CheckOptions>,
  ): Promise<{ report: GuardReport } | { failure: PipelineReport }> {
    try {
      const report = await this.runGuard({
        ...options,
        mode: 'guard',
      });
      if (report.ok === false) {
        this.logger.warn(`Guard 阻断, 流水线终止 (${report.summary.failed} 项失败)`);
        return { failure: buildFailureReport('guard', report, null) };
      }
      return { report };
    } catch (error) {
      this.logger.error(`Guard 检查失败: ${toMessage(error)}`);
      return { failure: buildFailureReport('guard', null, null, toMessage(error)) };
    }
  }

  /** 执行 Inspect 阶段：捕获异常并返回报告或失败报告 */
  private async runInspectPhase(
    guardReport: GuardReport,
  ): Promise<{ report: InspectionReport } | { failure: PipelineReport }> {
    try {
      const report = await this.runInspect();
      return { report };
    } catch (error) {
      this.logger.error(`Inspect 巡检失败: ${toMessage(error)}`);
      return { failure: buildFailureReport('inspect', guardReport, null, toMessage(error)) };
    }
  }

  async destroy(): Promise<void> {
    await this.pluginLoader.unloadAll();
    this.eventBus.removeAllListeners();
    this.guardEngine = null!;
    this.inspectEngine = null!;
    this.logger.info('流水线已关闭');
  }
}
