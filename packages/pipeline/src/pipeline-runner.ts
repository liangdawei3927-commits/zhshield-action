import {
  GuardEngine,
  GuardESLintCheckAdapter,
  GuardSensitiveInfoAdapter,
  ArchitectureBoundaryAdapter,
  TestRunnerAdapter,
  SecurityScanAdapter,
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
} from '@zh/inspect';
import type { InspectionReport } from '@zh/inspect';
import { RefactorEngine } from '@zh/refactor';
import type { RefactorReport } from '@zh/refactor';
import { SopRegistry, SopLoader, EventBus, PluginLoader, Logger, SopRuleEngine } from '@zh/kernel';
import type { Plugin, RuleContext, RuleEngineReport } from '@zh/kernel';
import type { PipelineReport } from './types';

/** 从 unknown 类型的 catch 错误中安全提取 message */
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

    this.registerDefaultAdapters();
  }

  private registerDefaultAdapters(): void {
    this.guardEngine.registerAdapter('eslint-check', new GuardESLintCheckAdapter());
    this.guardEngine.registerAdapter('sensitive-info', new GuardSensitiveInfoAdapter());
    this.guardEngine.registerAdapter('architecture-boundary', new ArchitectureBoundaryAdapter());
    this.guardEngine.registerAdapter('test-runner', new TestRunnerAdapter());
    this.guardEngine.registerAdapter('security-scan', new SecurityScanAdapter());
    // 注册 Inspect ToolAdapter → 经 useSopEngine 连线自动注入 SopRuleEngine
    this.inspectEngine.registerAdapter(new ESLintAdapter());
    this.inspectEngine.registerAdapter(new GitleaksAdapter());
    this.inspectEngine.registerAdapter(new DependencyCruiserAdapter());
    this.inspectEngine.registerAdapter(new JscpdAdapter());
    this.inspectEngine.registerAdapter(new TsPruneAdapter());
    this.inspectEngine.registerAdapter(new SemgrepAdapter());
    this.inspectEngine.registerAdapter(new DepcheckAdapter());
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
    const report = await this.sopRuleEngine.runGuard({
      repoRoot: this.repoRoot,
      dryRun: context?.dryRun ?? false,
      domain: 'guard',
      ...context,
    });
    this.logger.info(
      `SOP Guard 检查完成: ${report.passed} passed, ${report.failed} failed, ${report.errors} errors`,
    );
    return report;
  }

  async runSopInspect(context?: Partial<RuleContext>): Promise<RuleEngineReport> {
    this.logger.info('开始 SOP 驱动型 Inspect 巡检...');
    const report = await this.sopRuleEngine.runInspect({
      repoRoot: this.repoRoot,
      ...context,
    });
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

    let guardReport: RuleEngineReport | null = null;
    try {
      guardReport = await this.runSopGuard(options?.guardContext);
    } catch (error) {
      this.logger.error(`SOP Guard 检查失败: ${toMessage(error)}`);
      return {
        timestamp: new Date(),
        guard: null,
        inspect: null,
        refactor: null,
        passed: false,
        stage: 'guard',
        error: toMessage(error),
      };
    }

    if (!guardReport.ok) {
      this.logger.warn(`SOP Guard 阻断, 流水线终止 (${guardReport.failed} 项失败)`);
      return {
        timestamp: new Date(),
        guard: guardReport,
        inspect: null,
        refactor: null,
        passed: false,
        stage: 'guard',
      };
    }

    this.logger.info('SOP Guard 通过, 进入 SOP Inspect 巡检阶段...');
    let inspectReport: RuleEngineReport | null = null;
    try {
      inspectReport = await this.runSopInspect(options?.inspectContext);
    } catch (error) {
      this.logger.error(`SOP Inspect 巡检失败: ${toMessage(error)}`);
      return {
        timestamp: new Date(),
        guard: guardReport,
        inspect: null,
        refactor: null,
        passed: false,
        stage: 'inspect',
        error: toMessage(error),
      };
    }

    // 重构检测由桌面端「代码重构」页负责（马上检查 / 定时检查），全流水线不再串行跑重构
    this.logger.info('========== SOP 驱动型全流水线完成（不含重构） ==========');
    return {
      timestamp: new Date(),
      guard: guardReport,
      inspect: inspectReport,
      refactor: null,
      passed: true,
      stage: 'complete',
    };
  }

  // ─── checks.json 模式 ───

  async runFullPipeline(options?: Partial<CheckOptions>): Promise<PipelineReport> {
    this.logger.info('========== 智汇码盾全流水线开始 ==========');

    let guardReport: GuardReport | null = null;
    try {
      guardReport = await this.runGuard({
        ...options,
        mode: 'guard',
      });
    } catch (error) {
      this.logger.error(`Guard 检查失败: ${toMessage(error)}`);
      return {
        timestamp: new Date(),
        guard: null,
        inspect: null,
        refactor: null,
        passed: false,
        stage: 'guard',
        error: toMessage(error),
      };
    }

    if (guardReport.ok === false) {
      this.logger.warn(`Guard 阻断, 流水线终止 (${guardReport.summary.failed} 项失败)`);
      return {
        timestamp: new Date(),
        guard: guardReport,
        inspect: null,
        refactor: null,
        passed: false,
        stage: 'guard',
      };
    }

    this.logger.info('Guard 通过, 进入 Inspect 巡检阶段...');
    let inspectReport: InspectionReport | null = null;
    try {
      inspectReport = await this.runInspect();
    } catch (error) {
      this.logger.error(`Inspect 巡检失败: ${toMessage(error)}`);
      return {
        timestamp: new Date(),
        guard: guardReport,
        inspect: null,
        refactor: null,
        passed: false,
        stage: 'inspect',
        error: toMessage(error),
      };
    }

    // 重构由独立入口 runRefactor() / 桌面重构页负责
    this.logger.info('========== 智汇码盾全流水线完成（不含重构） ==========');
    return {
      timestamp: new Date(),
      guard: guardReport,
      inspect: inspectReport,
      refactor: null,
      passed: true,
      stage: 'complete',
    };
  }

  async destroy(): Promise<void> {
    await this.pluginLoader.unloadAll();
    this.eventBus.removeAllListeners();
    this.guardEngine = null!;
    this.inspectEngine = null!;
    this.logger.info('流水线已关闭');
  }
}
