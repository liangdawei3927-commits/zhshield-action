import type { CheckOptions, GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import { Logger } from '@zh/kernel';
import type { RuleContext, RuleEngineReport, ProjectFeature } from '@zh/kernel';
import type { PipelineReport } from './types';
import { detectProjectProfile, resolveEffectiveProjectRoot } from './project-profile';
import { toFeatureFromProfile } from '@zh/fingerprint';
import { toMessage } from './runner-utils';
import { buildFailureReport } from './report-builders';

/** 从本项目既有的 detectProjectProfile 探测结果派生 kernel 兼容的 ProjectFeature。
 *  投影委托给 fingerprint 的 toFeatureFromProfile（§11.1 投影资产，唯一投影家），
 *  本处仅保留探测调用与异常降级。失败/未知时返回 undefined（退化为不按画像过滤的安全行为）。
 *  探测前先经容器目录下探：直接以容器路径调用本函数（绕过 PipelineRunner 构造缝）时，
 *  画像同样识别到唯一嵌套仓库根（resolveEffectiveProjectRoot 对已解析根幂等）。
 */
export function deriveProjectFeature(repoRoot: string): ProjectFeature | undefined {
  try {
    const profile = detectProjectProfile(resolveEffectiveProjectRoot(repoRoot));
    return toFeatureFromProfile(profile);
  } catch {
    // 画像探测异常不影响体检主流程，退化为不按画像过滤（全量规则）的既有行为。
    return undefined;
  }
}

/**
 * 组装引擎所需 context：叠加 repoRoot + 阶段 domain，并在调用方未显式给定
 * projectFeature 时按画像自动注入（M2）。画像探测异常 → undefined → 引擎回退
 * 为不按画像过滤的全量规则评估（安全行为）。
 */
export function composeRuleContext(
  repoRoot: string,
  domain: 'guard' | 'inspect',
  partial?: Partial<RuleContext>,
): RuleContext {
  const base = {
    dryRun: domain === 'guard' ? (partial?.dryRun ?? false) : partial?.dryRun,
    ...partial,
    repoRoot,
  } satisfies RuleContext;
  if (!base.projectFeature) {
    const feature = deriveProjectFeature(repoRoot);
    if (feature) base.projectFeature = feature;
  }
  return base;
}

/**
 * 输出按画像裁剪观测：active=预裁剪活跃规则数，hit=命中后实际评估数，
 * 差值即画像驱动裁剪削减量（验证加载链路裁剪效果）。
 */
export function logTrimObservability(
  logger: Logger,
  report: RuleEngineReport,
  phase: string,
): void {
  const trim = report.profileTrim;
  if (!trim) {
    logger.info(`[${phase}] 未启用画像裁剪观测（无 projectFeature，全量评估）`);
    return;
  }
  const trimmed = trim.active - trim.hit;
  logger.info(
    `[${phase}] 画像裁剪观测: 活跃 ${trim.active} 条 → 命中 ${trim.hit} 条 (削减 ${trimmed} 条, ${Math.round((trimmed / trim.active) * 100)}%)`,
  );
}

/** 执行 SOP Guard 阶段：捕获异常并检查阻断，返回报告或失败报告 */
export async function runSopGuardPhase(
  logger: Logger,
  runSopGuard: (context?: Partial<RuleContext>) => Promise<RuleEngineReport>,
  guardContext?: Partial<RuleContext>,
): Promise<{ report: RuleEngineReport } | { failure: PipelineReport }> {
  try {
    const report = await runSopGuard(guardContext);
    if (!report.ok) {
      logger.warn(`SOP Guard 阻断, 流水线终止 (${report.failed} 项失败)`);
      return { failure: buildFailureReport('guard', report, null) };
    }
    return { report };
  } catch (error) {
    logger.error(`SOP Guard 检查失败: ${toMessage(error)}`);
    return { failure: buildFailureReport('guard', null, null, toMessage(error)) };
  }
}

/** 执行 SOP Inspect 阶段：捕获异常并返回报告或失败报告 */
export async function runSopInspectPhase(
  logger: Logger,
  runSopInspect: (context?: Partial<RuleContext>) => Promise<RuleEngineReport>,
  inspectContext: Partial<RuleContext> | undefined,
  guardReport: RuleEngineReport,
): Promise<{ report: RuleEngineReport } | { failure: PipelineReport }> {
  try {
    const report = await runSopInspect(inspectContext);
    if ((report.degraded ?? 0) > 0) {
      logger.warn(`SOP Inspect 降级: ${report.degraded} 项规则因工具不可用而跳过`);
      return { failure: buildFailureReport('inspect', guardReport, report) };
    }
    return { report };
  } catch (error) {
    logger.error(`SOP Inspect 巡检失败: ${toMessage(error)}`);
    return { failure: buildFailureReport('inspect', guardReport, null, toMessage(error)) };
  }
}

/** 执行 Guard 阶段：捕获异常并检查阻断，返回报告或失败报告 */
export async function runGuardPhase(
  logger: Logger,
  runGuard: (options?: Partial<CheckOptions>) => Promise<GuardReport>,
  options?: Partial<CheckOptions>,
): Promise<{ report: GuardReport } | { failure: PipelineReport }> {
  try {
    const report = await runGuard({ ...options, mode: 'guard' });
    if (report.ok === false) {
      logger.warn(`Guard 阻断, 流水线终止 (${report.summary.failed} 项失败)`);
      return { failure: buildFailureReport('guard', report, null) };
    }
    return { report };
  } catch (error) {
    logger.error(`Guard 检查失败: ${toMessage(error)}`);
    return { failure: buildFailureReport('guard', null, null, toMessage(error)) };
  }
}

/** 执行 Inspect 阶段：捕获异常并返回报告或失败报告 */
export async function runInspectPhase(
  logger: Logger,
  runInspect: () => Promise<InspectionReport>,
  guardReport: GuardReport,
): Promise<{ report: InspectionReport } | { failure: PipelineReport }> {
  try {
    const report = await runInspect();
    return { report };
  } catch (error) {
    logger.error(`Inspect 巡检失败: ${toMessage(error)}`);
    return { failure: buildFailureReport('inspect', guardReport, null, toMessage(error)) };
  }
}
