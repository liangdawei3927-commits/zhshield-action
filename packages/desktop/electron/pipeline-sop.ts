/**
 * SOP / 全流水线编排
 *
 * 负责「一键体检」的两条流水线：SOP 规则驱动（门禁 → 巡检）与
 * checks.json 模式（门禁 → 巡检），均不含重构检测（归「代码重构」页负责）。
 * 仅负责编排与进度上报，报告构建委托给 pipeline-report。
 */
import { t } from '@zh/i18n';
import { createReport, type PipelineReport } from '@zh/pipeline';
import type { GuardReport } from '@zh/guard';
import { serializePipelineReport } from './pipeline-protocol';
import { progress, send } from './pipeline-ipc';
import { attachSummary } from './pipeline-report';
import type { RuleEngineReport } from '@zh/kernel';

function createSkippedGuardReport(): RuleEngineReport {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 1,
    ok: true,
    blockingCount: 0,
    evaluations: [],
    durationMs: 0,
    timestamp: new Date(),
  };
}

function createSkippedChecksGuardReport(): GuardReport {
  return {
    contractVersion: 'p0.v1',
    mode: 'guard',
    profile: 'all',
    target: 'repo',
    ok: true,
    dryRun: false,
    summary: { total: 1, passed: 1, failed: 0, warnings: 0, blocking: 0, errors: 0 },
    results: [{
      checkId: 'GUARD-DISABLED',
      adapter: 'guard-switch',
      status: 'passed',
      severity: 'info',
      blocking: false,
      message: t('pipeline.guard.skippedDisabled'),
      duration: 0,
    }],
    generatedAt: new Date().toISOString(),
  };
}

type PipelineRunnerInstance = InstanceType<typeof import('@zh/pipeline')['PipelineRunner']>;

/** 运行 SOP 门禁阶段：通过时返回报告，未通过/异常时返回失败摘要 */
async function runSopGuardStage(
  id: string,
  runner: PipelineRunnerInstance,
  dryRun: boolean,
): Promise<{ guardReport: Awaited<ReturnType<typeof runner.runSopGuard>> } | { failure: PipelineReport }> {
  progress(id, 'guard', t('pipeline.guard.sopScanning'), 0.15);
  try {
    const guardReport = await runner.runSopGuard({ dryRun });
    if (guardReport.ok === false) {
      progress(id, 'guard', t('pipeline.guard.failed', { count: guardReport.failed }), 0.3);
      return {
        failure: attachSummary(createReport({
          guard: guardReport,
          passed: false,
          stage: 'guard',
        })),
      };
    }
    return { guardReport };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      failure: attachSummary(createReport({
        stage: 'guard',
        passed: false,
        error: message,
      })),
    };
  }
}

/** 运行 SOP 巡检阶段：通过时返回报告，异常时返回失败摘要 */
async function runSopInspectStage(
  id: string,
  runner: PipelineRunnerInstance,
  guardReport: Awaited<ReturnType<typeof runner.runSopGuard>>,
): Promise<{ inspectReport: Awaited<ReturnType<typeof runner.runSopInspect>> } | { failure: PipelineReport }> {
  progress(id, 'inspect', t('pipeline.inspect.sopScanning'), 0.45);
  try {
    const inspectReport = await runner.runSopInspect();
    return { inspectReport };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      failure: attachSummary(createReport({
        guard: guardReport,
        stage: 'inspect',
        passed: false,
        error: message,
      })),
    };
  }
}

async function runSopPipeline(
  id: string,
  runner: PipelineRunnerInstance,
  dryRun?: boolean,
  guardEnabled = true,
): Promise<PipelineReport> {
  let guardReport: Awaited<ReturnType<typeof runner.runSopGuard>>;

  if (!guardEnabled) {
    progress(id, 'guard', t('pipeline.guard.skippedDisabled'), 0.2);
    guardReport = createSkippedGuardReport() as Awaited<ReturnType<typeof runner.runSopGuard>>;
  } else {
    const guard = await runSopGuardStage(id, runner, dryRun ?? false);
    if ('failure' in guard) return guard.failure;
    guardReport = guard.guardReport;
  }

  const inspect = await runSopInspectStage(id, runner, guardReport);
  if ('failure' in inspect) return inspect.failure;

  // 重构检测归「代码重构」页负责，一键体检不跑重构
  const inspectFailed = (inspect.inspectReport.failed ?? 0) + (inspect.inspectReport.errors ?? 0);
  return attachSummary(createReport({
    guard: guardReport,
    inspect: inspect.inspectReport,
    passed: inspectFailed === 0,
    stage: 'complete',
  }));
}

/** SOP 模式：跑 SOP 流水线并发送完成消息 */
export async function runSopJob(
  id: string,
  runner: PipelineRunnerInstance,
  dryRun?: boolean,
  guardEnabled?: boolean,
): Promise<void> {
  const report = await runSopPipeline(id, runner, dryRun, guardEnabled);
  const summary = (report as { summary?: { total?: number; failed?: number; skipped?: number } }).summary;
  const doneMsg = report.passed
    ? t('pipeline.complete.total', { count: summary?.total ?? 0 })
    : t('pipeline.complete.foundIssues', { count: summary?.failed ?? 0 });
  progress(id, 'done', doneMsg, 1.0);
  send({ type: 'result', id, report: serializePipelineReport(report) });
}

/** checks.json 模式：门禁 → 巡检 → 完成（不含重构） */
export async function runFullPipelineJob(
  id: string,
  runner: PipelineRunnerInstance,
  dryRun?: boolean,
  guardEnabled = true,
): Promise<void> {
  let guardReport: Awaited<ReturnType<typeof runner.runGuard>>;

  if (!guardEnabled) {
    progress(id, 'guard', t('pipeline.guard.skippedDisabled'), 0.2);
    guardReport = createSkippedChecksGuardReport();
  } else {
    progress(id, 'guard', t('pipeline.guard.scanning'), 0.15);
    guardReport = await runner.runGuard({ dryRun });
    if (guardReport.ok === false) {
      progress(id, 'guard', t('pipeline.guard.failedBrief', { count: guardReport.summary.failed }), 0.3);
      const report = attachSummary(createReport({
        guard: guardReport,
        passed: false,
        stage: 'guard',
      }));
      send({ type: 'result', id, report: serializePipelineReport(report) });
      return;
    }
  }

  progress(id, 'inspect', t('pipeline.inspect.fullScanning'), 0.45);
  const inspectReport = await runner.runInspect();
  const report = attachSummary(createReport({
    guard: guardReport,
    inspect: inspectReport,
    passed: true,
    stage: 'complete',
  }));
  progress(id, 'done', t('pipeline.complete.done'), 1.0);
  send({ type: 'result', id, report: serializePipelineReport(report) });
}
