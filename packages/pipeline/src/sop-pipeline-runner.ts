import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import { Logger, SopRuleEngine } from '@zh/kernel';
import type { RuleContext, RuleEngineReport } from '@zh/kernel';
import { createReport, type PipelineReport } from './types';

/** 从 unknown 类型的 catch 错误中安全提取 message */
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SopGuardStageResult =
  { ok: true; report: RuleEngineReport } | { ok: false; earlyReturn: PipelineReport };

type SopInspectStageResult =
  { ok: true; report: RuleEngineReport } | { ok: false; earlyReturn: PipelineReport };

/**
 * @deprecated SOP 流水线已统一由 {@link PipelineRunner}（pipeline-runner.ts）实现：
 *  本类未被任何调用方引用、未导出，且未接入 M2「按项目画像裁剪」（projectFeature 线程），
 *  并保留过时的 "security 不在本路径" 注释（与 runInspect 的 inspect+security 语义不符）。
 *  请勿在本类上继续开发；删除前需同步 .omo/plans/zhcodeshield-simula-hardening.md 中
 *  对 sop-pipeline-runner.ts 门禁的文档引用。
 *
 * SOP-driven pipeline runner — Guard → Inspect（遗留实现）。
 */
export class SopPipelineRunner {
  private repoRoot: string;
  private sopRuleEngine: SopRuleEngine;
  private logger: Logger;

  constructor(repoRoot: string, sopRuleEngine: SopRuleEngine, logger: Logger) {
    this.repoRoot = repoRoot;
    this.sopRuleEngine = sopRuleEngine;
    this.logger = logger;
  }

  async runSopGuard(
    context?: Partial<RuleContext>,
    locale?: LanguageCode,
  ): Promise<RuleEngineReport> {
    this.logger.info(translate('engine.pipeline.log.sopGuardStart', locale ?? DEFAULT_LANGUAGE));
    const report = await this.sopRuleEngine.runGuard({
      repoRoot: this.repoRoot,
      dryRun: context?.dryRun ?? false,
      domain: 'guard',
      ...context,
    });
    this.logger.info(
      translate('engine.pipeline.log.sopGuardDone', locale ?? DEFAULT_LANGUAGE, {
        passed: report.passed,
        failed: report.failed,
        errors: report.errors,
      }),
    );
    return report;
  }

  async runSopInspect(
    context?: Partial<RuleContext>,
    locale?: LanguageCode,
  ): Promise<RuleEngineReport> {
    this.logger.info(translate('engine.pipeline.log.sopInspectStart', locale ?? DEFAULT_LANGUAGE));
    const report = await this.sopRuleEngine.runInspect({
      repoRoot: this.repoRoot,
      ...context,
    });
    this.logger.info(
      translate('engine.pipeline.log.sopInspectDone', locale ?? DEFAULT_LANGUAGE, {
        passed: report.passed,
        failed: report.failed,
        skipped: report.skipped,
      }),
    );
    return report;
  }

  async runSopDrivenPipeline(
    options?: {
      guardContext?: Partial<RuleContext>;
      inspectContext?: Partial<RuleContext>;
    },
    locale?: LanguageCode,
  ): Promise<PipelineReport> {
    this.logger.info(translate('engine.pipeline.log.sopPipelineStart', locale ?? DEFAULT_LANGUAGE));

    const guardStage = await this.runSopGuardStage(options?.guardContext, locale);
    if (!guardStage.ok) return guardStage.earlyReturn;

    this.logger.info(translate('engine.pipeline.log.sopGuardPassed', locale ?? DEFAULT_LANGUAGE));
    const inspectStage = await this.runSopInspectStage(
      options?.inspectContext,
      guardStage.report,
      locale,
    );
    if (!inspectStage.ok) return inspectStage.earlyReturn;

    // 重构检测由桌面端「代码重构」页负责（马上检查 / 定时检查），全流水线不再串行跑重构
    this.logger.info(translate('engine.pipeline.log.sopPipelineDone', locale ?? DEFAULT_LANGUAGE));
    return createReport({
      guard: guardStage.report,
      inspect: inspectStage.report,
      passed: true,
      stage: 'complete',
    });
  }

  private async runSopGuardStage(
    context?: Partial<RuleContext>,
    locale?: LanguageCode,
  ): Promise<SopGuardStageResult> {
    let guardReport: RuleEngineReport | null = null;
    try {
      guardReport = await this.runSopGuard(context, locale);
    } catch (error) {
      this.logger.error(
        translate('engine.pipeline.log.sopGuardFailed', locale ?? DEFAULT_LANGUAGE, {
          error: toMessage(error),
        }),
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
        translate('engine.pipeline.log.sopGuardBlocked', locale ?? DEFAULT_LANGUAGE, {
          failed: guardReport.failed,
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

  private async runSopInspectStage(
    context: Partial<RuleContext> | undefined,
    guardReport: RuleEngineReport,
    locale?: LanguageCode,
  ): Promise<SopInspectStageResult> {
    try {
      const inspectReport = await this.runSopInspect(context, locale);
      return { ok: true, report: inspectReport };
    } catch (error) {
      this.logger.error(
        translate('engine.pipeline.log.sopInspectFailed', locale ?? DEFAULT_LANGUAGE, {
          error: toMessage(error),
        }),
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
}
