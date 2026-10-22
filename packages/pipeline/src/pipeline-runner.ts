import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { SecurityCheckEngine, TrivyAdapter } from '@zh/security';
import { SopRegistry, SopLoader, EventBus, PluginLoader, Logger, SopRuleEngine } from '@zh/kernel';
import type { Plugin, RuleContext, RuleEngineReport } from '@zh/kernel';
import { EventCenter, subscribeScopeViolations } from '@zh/sentinel';
import { loadBaseline, filterIssuesByBaseline, type Baseline } from '@zh/shared';
import type { PipelineReport } from './types';
import { registerAutoPerfAdapter } from './autoperf-adapter';
import { SonarwayToolAdapter } from './sonarway-tool-adapter';
import { toMessage } from './runner-utils';
import { buildSuccessReport } from './report-builders';
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

type SyncRuleArray = Parameters<SopLoader['loadFromKnowledgeBase']>[0];

async function readModulesDir(logger: Logger, modulesDir: string): Promise<string[] | null> {
  try {
    return await fs.promises.readdir(modulesDir);
  } catch {
    logger.warn(`同步规则缓存目录不可用，回退内置模板: ${modulesDir}`);
    return null;
  }
}

async function readSyncedRules(
  logger: Logger,
  modulesDir: string,
  dbFiles: string[],
): Promise<SyncRuleArray> {
  const synced: SyncRuleArray = [];
  for (const file of dbFiles) {
    try {
      const raw = await fs.promises.readFile(path.join(modulesDir, file), 'utf-8');
      const rules = JSON.parse(raw) as SyncRuleArray;
      if (Array.isArray(rules)) synced.push(...rules);
    } catch (err) {
      logger.warn(`同步规则模块 ${file} 解析失败: ${toMessage(err)}`);
    }
  }
  return synced;
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
    this.repoRoot = path.resolve(repoRoot);
    this.logger = new Logger('Pipeline', 'info');

    this.eventBus = new EventBus();
    this.eventCenter = new EventCenter();
    subscribeScopeViolations(this.eventBus, this.eventCenter);
    this.pluginLoader = new PluginLoader();

    // SOP 系统
    this.sopRegistry = new SopRegistry(this.eventBus);

    // SOP 规则目录：指向内置规则模板（{domain}/{action}/**/*.yml，44 条）。
    // 注：根目录 kernel/src/sop 已无 {guard,inspect,...}/{action} 一层，规则都在
    // presets/sop-templates 下，若指向 src/sop 会加载到 0 条 → 体检 0 检查项 + 默认满分。
    // 运行于 dist 树时（打包后）用 kernel/dist 的模板（构建会把 yml 一并拷贝），dev 走 src。
    const defaultRulesDir = __dirname.includes('/dist/')
      ? require('path').resolve(
          __dirname,
          '..',
          '..',
          'kernel',
          'dist',
          'sop',
          'presets',
          'sop-templates',
        )
      : require('path').resolve(
          __dirname,
          '..',
          '..',
          'kernel',
          'src',
          'sop',
          'presets',
          'sop-templates',
        );

    this.sopRulesDir = options?.configDir || defaultRulesDir;
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
    if (count === 0) {
      this.logger.error(
        `SOP 规则加载降级: 0 条规则 — 引擎处于盲检状态，所有检查将默认通过。请检查规则目录: ${this.sopRulesDir}`,
      );
    } else {
      this.logger.info(`SOP 规则已加载: ${count} 条 (活跃: ${stats.byStatus.active || 0})`);
    }
    return count;
  }

  /**
   * 从同步缓存加载云端同步的规则（{cacheDir}/modules/*.db，JSON 数组），
   * 与内置模板合并：按 id 覆盖内置同 id 规则（REMOTE_WINS），
   * 缓存独有的规则直接注册。返回加载条数；缓存目录缺失或无规则文件时返回 0。
   */
  async loadSopRulesFromCache(cacheDir: string): Promise<number> {
    const modulesDir = path.join(cacheDir, 'modules');
    const files = await readModulesDir(this.logger, modulesDir);
    if (!files) return 0;

    const dbFiles = files.filter((f) => f.endsWith('.db') && !f.startsWith('.'));
    if (dbFiles.length === 0) return 0;

    const synced = await readSyncedRules(this.logger, modulesDir, dbFiles);
    if (synced.length === 0) return 0;

    await this.sopLoader.loadFromKnowledgeBase(synced);
    const stats = this.sopRegistry.getStats();
    this.logger.info(
      `SOP 同步规则已加载: ${synced.length} 条 (活跃: ${stats.byStatus.active || 0})`,
    );
    return synced.length;
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

  async destroy(): Promise<void> {
    await this.pluginLoader.unloadAll();
    this.eventBus.removeAllListeners();
    this.guardEngine = null!;
    this.inspectEngine = null!;
    this.logger.info('流水线已关闭');
  }
}
