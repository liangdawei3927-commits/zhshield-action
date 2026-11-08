/**
 * SOP / 全流水线编排
 *
 * 负责「一键体检」的两条流水线：SOP 规则驱动（门禁 → 巡检）与
 * checks.json 模式（门禁 → 巡检），均不含重构检测（归「代码重构」页负责）。
 * 仅负责编排与进度上报，报告构建委托给 pipeline-report。
 */
import { t } from '@zh/i18n';
import { createReport, type PipelineReport, loadGuardConclusions, runDomain } from '@zh/pipeline';
import type { GuardReport } from '@zh/guard';
import { serializePipelineReport } from './pipeline-protocol';
import { progress, send } from './pipeline-ipc';
import { attachSummary } from './pipeline-report';
import type { RuleEngineReport, SopRule } from '@zh/kernel';

// 门禁结论集的读取由 @zh/pipeline 单一实现（CLI 与桌面端共用），此处只转出
export { loadGuardConclusions };

function createSkippedGuardReport(): RuleEngineReport {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 1,
    degraded: 0,
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
    results: [
      {
        checkId: 'GUARD-DISABLED',
        adapter: 'guard-switch',
        status: 'passed',
        severity: 'info',
        blocking: false,
        message: t('pipeline.guard.skippedDisabled'),
        duration: 0,
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

type PipelineRunnerInstance = InstanceType<(typeof import('@zh/pipeline'))['PipelineRunner']>;

/**
 * 合成门禁评估用的占位规则。
 *
 * `RuleEvaluation.rule` 的类型是完整 SopRule；本条目只用于把「门禁未产出结论」
 * 表达成一条评估，规则本身不参与执行。逐字段给出合法默认值，避免用
 * 双重类型断言绕过类型检查（那等于绕过类型系统，字段改名后会静默失效）。
 */
function createSyntheticGuardRule(name: string): SopRule {
  const now = new Date();
  return {
    id: 'guard-stage',
    name,
    domain: 'guard',
    action: 'block',
    source: 'internal',
    description: name,
    status: 'active',
    executionMode: 'sync',
    severity: 'info',
    applicableEngines: ['guard'],
    content: {},
    tags: [],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** 门禁域的异常报告：域驱动不会抛出，缺报告即"未检测成"（C4） */
function createGuardErrorReport(message: string): RuleEngineReport {
  return {
    total: 1,
    passed: 0,
    failed: 0,
    errors: 1,
    skipped: 0,
    degraded: 0,
    ok: false,
    blockingCount: 0,
    evaluations: [
      {
        status: 'error',
        message,
        durationMs: 0,
        targetEngine: 'guard',
        timestamp: new Date(),
        // 合成条目只用于说清「门禁未产出结论」，不参与规则执行。
        rule: createSyntheticGuardRule(t('pipeline.guard.sopScanning')),
      },
    ],
    durationMs: 0,
    timestamp: new Date(),
  };
}

/** 运行 SOP 门禁阶段：始终返回报告与通过状态（失败不阻断后续巡检） */
async function runSopGuardStage(
  id: string,
  runner: PipelineRunnerInstance,
  dryRun: boolean,
): Promise<{ guardReport: Awaited<ReturnType<typeof runner.runSopGuard>>; ok: boolean }> {
  progress(id, 'guard', t('pipeline.guard.sopScanning'), 0.15);
  // 与 CLI / 无头脚本同一域执行器：结论读取（A6）与 SOP 规则集不容第二份实现
  const record = await runDomain('guard', {
    repoRoot: runner.repoRoot,
    runner,
    ...(dryRun ? { dryRun } : {}),
  });
  const guardReport = record.report as Awaited<ReturnType<typeof runner.runSopGuard>> | undefined;
  if (!guardReport) {
    return {
      ok: false,
      guardReport: createGuardErrorReport(
        `门禁域未产出结论（${record.status}）：${record.reason ?? '无原因'}`
      ) as Awaited<ReturnType<typeof runner.runSopGuard>>,
    };
  }
  if (guardReport.ok === false) {
    progress(id, 'guard', t('pipeline.guard.failed', { count: guardReport.failed }), 0.3);
    return { guardReport, ok: false };
  }
  return { guardReport, ok: true };
}

/** 运行 SOP 巡检阶段：通过时返回报告，异常时返回失败摘要 */
async function runSopInspectStage(
  id: string,
  runner: PipelineRunnerInstance,
  guardReport: Awaited<ReturnType<typeof runner.runSopGuard>>,
): Promise<
  { inspectReport: Awaited<ReturnType<typeof runner.runSopInspect>> } | { failure: PipelineReport }
> {
  progress(id, 'inspect', t('pipeline.inspect.sopScanning'), 0.45);
  // 巡检编排同样走域驱动：规则集、基线豁免与单域运行口径只此一份
  const record = await runDomain('inspect', { repoRoot: runner.repoRoot, runner });
  const inspectReport = record.report as Awaited<ReturnType<typeof runner.runSopInspect>> | undefined;
  if (!inspectReport) {
    return {
      failure: attachSummary(
        createReport({
          guard: guardReport,
          stage: 'inspect',
          passed: false,
          error: `巡检域未产出结论（${record.status}）：${record.reason ?? '无原因'}`,
        }),
      ),
    };
  }
  return { inspectReport };
}

async function runSopPipeline(
  id: string,
  runner: PipelineRunnerInstance,
  dryRun?: boolean,
  guardEnabled = true,
): Promise<PipelineReport> {
  let guardReport: Awaited<ReturnType<typeof runner.runSopGuard>>;
  let guardOk = true;

  if (!guardEnabled) {
    progress(id, 'guard', t('pipeline.guard.skippedDisabled'), 0.2);
    guardReport = createSkippedGuardReport() as Awaited<ReturnType<typeof runner.runSopGuard>>;
  } else {
    const guard = await runSopGuardStage(id, runner, dryRun ?? false);
    guardReport = guard.guardReport;
    guardOk = guard.ok;
  }

  const inspect = await runSopInspectStage(id, runner, guardReport);
  if ('failure' in inspect) return inspect.failure;

  // 重构检测归「代码重构」页负责，一键体检不跑重构
  const inspectFailed = (inspect.inspectReport.failed ?? 0) + (inspect.inspectReport.errors ?? 0);
  const inspectDegraded = (inspect.inspectReport.degraded ?? 0) > 0;
  return attachSummary(
    createReport({
      guard: guardReport,
      inspect: inspect.inspectReport,
      passed: guardOk && inspectFailed === 0 && !inspectDegraded,
      stage: 'complete',
    }),
  );
}

/** SOP 模式：跑 SOP 流水线并发送完成消息 */
export async function runSopJob(
  id: string,
  runner: PipelineRunnerInstance,
  dryRun?: boolean,
  guardEnabled?: boolean,
): Promise<void> {
  const report = await runSopPipeline(id, runner, dryRun, guardEnabled);
  const summary = (report as { summary?: { total?: number; failed?: number; skipped?: number } })
    .summary;
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
  let guardOk = true;

  if (!guardEnabled) {
    progress(id, 'guard', t('pipeline.guard.skippedDisabled'), 0.2);
    guardReport = createSkippedChecksGuardReport();
  } else {
    progress(id, 'guard', t('pipeline.guard.scanning'), 0.15);
    guardReport = await runner.runGuard({ dryRun });
    if (guardReport.ok === false) {
      progress(
        id,
        'guard',
        t('pipeline.guard.failedBrief', { count: guardReport.summary.failed }),
        0.3,
      );
      guardOk = false;
    }
  }

  progress(id, 'inspect', t('pipeline.inspect.fullScanning'), 0.45);
  const inspectReport = await runner.runInspect();
  const report = attachSummary(
    createReport({
      guard: guardReport,
      inspect: inspectReport,
      passed: guardOk,
      stage: 'complete',
    }),
  );
  progress(id, 'done', t('pipeline.complete.done'), 1.0);
  send({ type: 'result', id, report: serializePipelineReport(report) });
}
