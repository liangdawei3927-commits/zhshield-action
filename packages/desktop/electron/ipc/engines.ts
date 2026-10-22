/**
 * 治理引擎 IPC（ipc/engines.ts）
 *
 * Guard / Inspect / Security / Refactor / Pipeline / Scoring 全部走子进程执行，
 * 主进程仅转发与转换报告；体检发现问题后自动触发 opencode CLI 修复（非阻塞）。
 *
 * 处理器实现按域拆分至同目录 engines-*.ts（scoring / deps / techdebt / secrets / scanners），
 * 本文件保留 IPC 注册（registerEnginesIpc）与触发权/跨域耦合留在本域的处理函数；
 * 依赖方向单向：本文件 → engines-*.ts，新文件一律不得 import 本文件。
 */

import { ipcMain } from 'electron';
import { t } from '@zh/i18n';
import type { CheckOptions, GuardReport } from '@zh/guard';
import { appendGuardReport, toGuardReportRecord } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { GarbageScanReport } from '@zh/garbage';
import { createReport, type PipelineReport } from '@zh/pipeline';

import { convertGuardEvaluations, convertInspectEvaluations } from './score-converters';
import {
  persistDiagnostics,
  persistDiagnosticsFromEntries,
  normalizeGuardSource,
  normalizePerformanceData,
} from '../zh-diagnostics';
import { updateDashboardState } from './dashboard-state';
import { shouldAutoFix, countFixableIssues, resolveOpenCodeBin } from '../ai-auto-fix';
import { getScoring } from '../ipc-context';
import type { TaskManager } from '../task-manager';
import { toGuardReportData, type GuardReportData, type PerformanceReportData } from './report-format';
import type { TechDebtReportData } from '../../src/types/electron';

import {
  ResolvedPipelineReports,
  probeProjectProfile,
  computePipelineHealthScore,
  scorePipelineModules,
  generateReportSummaryHandler,
  getScoreHandler,
  getScoreHistoryHandler,
  getDomainScoreHandler,
  runProfileHandler,
  getProfileHandler,
} from './engines-scoring';
import {
  readDiagnosticsReport,
  collectOpenCodeCandidates,
  spawnOpenCodeFix,
  runSecurityHandler,
  runRefactorHandler,
  garbageCleanHandler,
  garbageRestoreHandler,
  garbageDashboardPatch,
  performanceDashboardPatch,
} from './engines-scanners';
import { runDepsHandler, depsRelockBaselineHandler } from './engines-deps';
import {
  loadDebtInputFromSnapshot,
  buildTechDebtSnapshot,
  mergeDebtPersistence,
  persistTechDebtDiagnostics,
  updateTechDebtDashboard,
  planDebtRepaymentHandler,
  verifyDebtRepaidHandler,
  dismissDebtActionHandler,
} from './engines-techdebt';
import {
  runSecretsHandler,
  markSecretRotatingHandler,
  verifySecretRotatedHandler,
  dismissSecretHandler,
} from './engines-secrets';

/**
 * 体检发现问题后自动触发 opencode CLI 修复（非阻塞）。
 * 仅当诊断含 error/warning 时触发；门禁（guard/预防）类问题不自动触发，
 * 只保留手动「复制到AI」能力；opencode 不在 PATH 时静默跳过，不打扰用户。
 * 内部全量捕获，返回的 Promise 永不 reject，调用方可安全 fire-and-forget。
 */
async function triggerOpenCodeAutoFix(projectPath: string, diagnosticsPath: string): Promise<void> {
  try {
    const report = await readDiagnosticsReport(diagnosticsPath);
    if (!shouldAutoFix(report)) return;

    const { error: fixableError, warning: fixableWarning } = countFixableIssues(report);
    const bin = resolveOpenCodeBin(process.env.ZH_OPENCODE_BIN, await collectOpenCodeCandidates());
    if (!bin) {
      console.warn('[ai:autofix] 未找到 opencode CLI，跳过自动修复');
      return;
    }

    spawnOpenCodeFix(bin, projectPath, fixableError, fixableWarning);
  } catch (err) {
    console.warn('[ai:autofix] 自动触发失败:', err instanceof Error ? err.message : String(err));
  }
}

function isRuleEngineReport(r: unknown): r is { total: number; evaluations: unknown[] } {
  return !!r && typeof r === 'object' && 'total' in r && 'evaluations' in r;
}

/** 解析评分输入的报告格式：SOP/传统；缺报告或格式混合时跳过评分（返回 null） */
function resolvePipelineReports(report: PipelineReport): ResolvedPipelineReports | null {
  const guardReport = report.guard;
  const inspectReport = report.inspect;
  if (!guardReport || !inspectReport) {
    console.warn('[engine:runPipeline] 跳过评分: 缺少 guard 或 inspect 报告', {
      hasGuard: !!guardReport,
      hasInspect: !!inspectReport,
    });
    return null;
  }
  const isSop = isRuleEngineReport(guardReport) && isRuleEngineReport(inspectReport);
  if (isSop) {
    return {
      isSop: true,
      guardResults: convertGuardEvaluations(guardReport.evaluations),
      inspectIssues: convertInspectEvaluations(inspectReport.evaluations),
    };
  }
  if (isRuleEngineReport(guardReport) || isRuleEngineReport(inspectReport)) {
    console.warn('[engine:runPipeline] 跳过评分: 混合报告格式（guard/inspect 不同类型）');
    return null;
  }
  return {
    isSop: false,
    guardResults: (guardReport as GuardReport).results,
    inspectIssues: (inspectReport as InspectionReport).issues,
  };
}

async function recordPipelineScore(projectPath: string, report: PipelineReport): Promise<void> {
  try {
    const resolved = resolvePipelineReports(report);
    if (!resolved) return;
    const scoring = await getScoring();
    const profilingResult = await probeProjectProfile(projectPath);
    await computePipelineHealthScore(projectPath, resolved, profilingResult, scoring);
    await scorePipelineModules({ projectPath, report, resolved, profilingResult, scoring });
  } catch (err) {
    console.warn(
      '[engine:runPipeline] 健康评分落库失败:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function registerEnginesIpc(manager: TaskManager): void {
  ipcMain.handle('engine:runGuard', (_e, projectPath: string, options?: Partial<CheckOptions>) =>
    runGuardHandler(manager, projectPath, options),
  );
  ipcMain.handle('engine:runSecurity', (_e, projectPath: string) =>
    runSecurityHandler(manager, projectPath),
  );
  ipcMain.handle('engine:runGarbageScan', (_e, projectPath: string) =>
    runGarbageScanHandler(manager, projectPath),
  );
  ipcMain.handle('engine:garbageClean', (_e, projectPath: string, items: unknown) =>
    garbageCleanHandler(manager, projectPath, items),
  );
  ipcMain.handle('engine:garbageRestore', (_e, projectPath: string, batchId: string) =>
    garbageRestoreHandler(manager, projectPath, batchId),
  );
  ipcMain.handle('engine:runPerformance', (_e, projectPath: string) =>
    runPerformanceHandler(manager, projectPath),
  );
  ipcMain.handle('engine:runRefactor', (_e, projectPath: string) =>
    runRefactorHandler(manager, projectPath),
  );
  ipcMain.handle('engine:runDeps', (_e, projectPath: string) => runDepsHandler(projectPath));
  ipcMain.handle('engine:depsRelockBaseline', (_e, projectPath: string) =>
    depsRelockBaselineHandler(projectPath),
  );
  ipcMain.handle('engine:runTechDebt', (_e, projectPath: string) =>
    runTechDebtHandler(projectPath),
  );
  ipcMain.handle(
    'debt:planRepayment',
    (
      _e,
      projectPath: string,
      actionId: string,
      opts?: { sprint?: string; gate?: 'allow-with-record' },
    ) => planDebtRepaymentHandler(projectPath, actionId, opts),
  );
  ipcMain.handle('debt:verifyRepaid', (_e, projectPath: string, actionId: string) =>
    verifyDebtRepaidHandler(projectPath, actionId),
  );
  ipcMain.handle('debt:dismiss', (_e, projectPath: string, actionId: string) =>
    dismissDebtActionHandler(projectPath, actionId),
  );
  ipcMain.handle('engine:runSecrets', (_e, projectPath: string) => runSecretsHandler(projectPath));
  ipcMain.handle('engine:secretRotating', (_e, secretId: string) =>
    markSecretRotatingHandler(secretId),
  );
  ipcMain.handle('engine:secretVerify', (_e, secretId: string) =>
    verifySecretRotatedHandler(secretId),
  );
  ipcMain.handle('engine:secretDismiss', (_e, secretId: string, reason: string) =>
    dismissSecretHandler(secretId, reason),
  );
  ipcMain.handle(
    'engine:runPipeline',
    (_e, projectPath: string, options?: { dryRun?: boolean; sop?: boolean }) =>
      runPipelineHandler(manager, projectPath, options),
  );
  ipcMain.handle('engine:getScore', getScoreHandler);
  ipcMain.handle('engine:getScoreHistory', getScoreHistoryHandler);
  ipcMain.handle('engine:getDomainScore', getDomainScoreHandler);
  ipcMain.handle('engine:getProfile', getProfileHandler);
  ipcMain.handle('engine:runProfile', (_e, projectPath: string) => runProfileHandler(projectPath));
  // 报告中心：只读汇总各域最新结果并落库（不发起检查；无结果时返回 null）
  ipcMain.handle('engine:generateReportSummary', (_e, projectPath: string) =>
    generateReportSummaryHandler(projectPath),
  );
}

async function runGuardHandler(
  manager: TaskManager,
  projectPath: string,
  options?: Partial<CheckOptions>,
): Promise<GuardReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const task = manager.start('guard', projectPath, options);
    const report = (await manager.waitFor(task.id)) as GuardReport;
    try {
      await persistDiagnosticsFromEntries(projectPath, normalizeGuardSource(report), ['guard']);
    } catch (e) {
      console.warn('[engine:runGuard] 诊断落盘失败:', e instanceof Error ? e.message : String(e));
    }
    try {
      appendGuardReport(
        projectPath,
        toGuardReportRecord(report, options?.triggerSource ?? 'manual'),
      );
    } catch (e) {
      console.warn('[engine:runGuard] 报告落库失败:', e instanceof Error ? e.message : String(e));
    }
    return toGuardReportData(report);
  } catch (err) {
    console.error('[engine:runGuard] Error:', err);
    return {
      summary: { totalChecks: 0, passed: 0, blocked: 0, warnings: 0 },
      checks: [],
      metadata: { duration: 0, timestamp: new Date().toISOString() },
    };
  }
}

/**
 * 垃圾清理扫描（T5）：触发 garbage 任务（非 security），只跑垃圾清理域自有能力。
 * 页面的 loading/进度取自任务中心的 garbage 任务，不再借 security 任务。
 */
async function runGarbageScanHandler(
  manager: TaskManager,
  projectPath: string,
): Promise<GarbageScanReport> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error(t('electron.invalidProjectPath'));
  }
  try {
    const task = manager.start('garbage', projectPath);
    const report = (await manager.waitFor(task.id)) as GarbageScanReport;
    // 十域评分：垃圾扫描结果落 dashboard-state（供报告中心只读汇总 garbage 维）
    try {
      await updateDashboardState(projectPath, { garbage: garbageDashboardPatch(report) });
    } catch (e) {
      console.warn(
        '[engine:runGarbageScan] dashboard-state 落盘失败:',
        e instanceof Error ? e.message : String(e),
      );
    }
    return report;
  } catch (err) {
    console.error('[engine:runGarbageScan] Error:', err);
    return {
      projectPath,
      items: [],
      summary: { total: 0, size: 0, byType: {} },
      checks: [],
      skipped: 0,
      timestamp: new Date().toISOString(),
    };
  }
}

async function runPerformanceHandler(
  manager: TaskManager,
  projectPath: string,
): Promise<PerformanceReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const task = manager.start('performance', projectPath);
    const result = (await manager.waitFor(task.id)) as PerformanceReportData;
    try {
      await persistDiagnosticsFromEntries(projectPath, normalizePerformanceData(result), [
        'performance',
      ]);
    } catch (e) {
      console.warn(
        '[engine:runPerformance] 诊断落盘失败:',
        e instanceof Error ? e.message : String(e),
      );
    }
    // P1b: 补写 dashboard-state performance 域（问题总数 + severity 分布 + lastRunAt）
    await updateDashboardState(projectPath, { performance: performanceDashboardPatch(result) });
    return result;
  } catch (err) {
    console.error('[engine:runPerformance] Error:', err);
    return {
      summary: { total: 0, autoFixable: 0 },
      issues: [],
      metadata: { duration: 0, timestamp: new Date().toISOString() },
    };
  }
}

/** 技术债仪表盘失败时的空报告（error 携带失败原因，不 throw） */
function emptyTechDebtReport(error: string): TechDebtReportData {
  return {
    projectId: '',
    generatedAt: new Date().toISOString(),
    debtIndex: 0,
    trend: { period: 'week', delta: 0 },
    byModule: [],
    byCategory: [],
    actionList: [],
    error,
  };
}

async function runTechDebtHandler(projectPath: string): Promise<TechDebtReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const input = await loadDebtInputFromSnapshot(projectPath);
    if (!input.ok) {
      console.warn('[engine:runTechDebt] 无 inspect 域快照，提示先运行项目体检');
      return emptyTechDebtReport(t('electron.techDebtNoSnapshot'));
    }
    const snapshot = await buildTechDebtSnapshot(projectPath, input);
    const finalSnapshot = await mergeDebtPersistence(snapshot);
    const report: TechDebtReportData = { ...finalSnapshot, error: null };
    await persistTechDebtDiagnostics(projectPath, report);
    await updateTechDebtDashboard(projectPath, report);
    return report;
  } catch (err) {
    console.error('[engine:runTechDebt] Error:', err);
    return emptyTechDebtReport(err instanceof Error ? err.message : String(err));
  }
}

async function runPipelineHandler(
  manager: TaskManager,
  projectPath: string,
  options?: { dryRun?: boolean; sop?: boolean },
): Promise<PipelineReport> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const task = manager.start('pipeline', projectPath, options ?? {});
    const report = (await manager.waitFor(task.id)) as PipelineReport;
    if (!options?.dryRun) {
      try {
        const diagnosticsPath = await persistDiagnostics(projectPath, report);
        void triggerOpenCodeAutoFix(projectPath, diagnosticsPath);
      } catch (err) {
        console.warn(
          '[engine:runPipeline] 诊断文件写入失败:',
          err instanceof Error ? err.message : String(err),
        );
      }
      // 评分必须先落库再返回报告：渲染层在 runPipeline 返回后立即 getScore，
      // 若 fire-and-forget 会导致 UI 读到上一轮的旧评分（health_scores 显示滞后一轮）。
      await recordPipelineScore(projectPath, report);
    }
    return report;
  } catch (err) {
    console.error(
      '[engine:runPipeline] 流水线执行异常:',
      err instanceof Error ? err.stack || err.message : String(err),
    );
    return createReport({
      stage: 'failed',
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// 画像缓存辅助：实现已拆分至 engines-scoring.ts，此处保持原模块导出面不变
export { cacheProfileFromFingerprintResult } from './engines-scoring';
