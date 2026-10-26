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
import { rethrowIfCancelled } from '../pipeline-protocol';
import { toGuardReportData, type GuardReportData, type PerformanceReportData } from './report-format';
import type { DependencyReportData, TechDebtReportData } from '../../src/types/electron';

import {
  ResolvedPipelineReports,
  probeProjectProfile,
  computePipelineHealthScore,
  scorePipelineModules,
  generateReportSummaryHandler,
  getScoreHandler,
  getScoreHistoryHandler,
  getDomainScoreHandler,
  getHealthOverviewHandler,
  getDomainReportHandler,
  runProfileHandler,
  getProfileHandler,
} from './engines-scoring';
import {
  saveDomainReportHandler,
  getSavedDomainReportHandler,
  getDomainSnapshotRawHandler,
  hasDomainResultHandler,
} from './domain-reports';
import {
  getDomainScanBlobHandler,
  getLatestDomainScanHandler,
  listDomainHistoryHandler,
} from './domain-history-ipc';
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
import { depsRelockBaselineHandler } from './engines-deps';
import {
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
    // 总分走「各域最新落盘结果汇总」（与报告中心/分类页同一函数、同一份输入）；
    // 模块级评分仍消费本次报告（模块分不进总分）。
    await computePipelineHealthScore(projectPath);
    await scorePipelineModules({ projectPath, report, resolved, profilingResult, scoring });
  } catch (err) {
    console.warn(
      '[engine:runPipeline] 健康评分落库失败:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 单域扫描后的「总分补记」。
 *
 * 为什么需要：七个单域扫描（guard / security / garbage / performance / refactor /
 * deps / techdebt）此前只更新域快照 + dashboard-state，**不写总分**；只有跑完整
 * pipeline 或手动点「汇总生成报告」才落一条。结果是「一天扫十几次」在报告中心
 * 只表现为「点过汇总的那几次」，趋势分析的分母与真实扫描次数不符。
 *
 * 口径：直接复用写分点 2/2 `generateReportSummaryHandler`（只读各域最新落盘结果，
 * 不触发任何扫描），不新开第三条算分路径 —— 否则同一时刻会写出两个分、历史趋势断裂。
 *
 * 失败只 warn：补记失败不能让扫描结果丢失，也不能让扫描本身报错。
 */
async function recordDomainScanScore(projectPath: string): Promise<void> {
  try {
    await generateReportSummaryHandler(projectPath);
  } catch (err) {
    console.warn(
      '[engine:runDomain] 扫描后总分补记失败（扫描结果不受影响）:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 包裹单域扫描：先拿到扫描结果，再补记总分。
 *
 * ⚠️ 只用于「不写总分」的单域扫描。`runPipeline` 自带 `recordPipelineScore`，
 * 再包一层会让一次扫描写两条总分（历史曲线出现重复点）。
 */
async function withDomainScore<T>(projectPath: string, run: () => Promise<T>): Promise<T> {
  const result = await run();
  await recordDomainScanScore(projectPath);
  return result;
}

/** 域扫描入口：各域 run* + 垃圾清理/恢复（除 deps/techdebt 需先起任务再等结果） */
function registerEngineRunHandlers(manager: TaskManager): void {
  ipcMain.handle('engine:runGuard', (_e, projectPath: string, options?: Partial<CheckOptions>) =>
    withDomainScore(projectPath, () => runGuardHandler(manager, projectPath, options)),
  );
  ipcMain.handle('engine:runSecurity', (_e, projectPath: string) =>
    withDomainScore(projectPath, () => runSecurityHandler(manager, projectPath)),
  );
  ipcMain.handle('engine:runGarbageScan', (_e, projectPath: string) =>
    withDomainScore(projectPath, () => runGarbageScanHandler(manager, projectPath)),
  );
  ipcMain.handle('engine:garbageClean', (_e, projectPath: string, items: unknown) =>
    garbageCleanHandler(manager, projectPath, items),
  );
  ipcMain.handle('engine:garbageRestore', (_e, projectPath: string, batchId: string) =>
    garbageRestoreHandler(manager, projectPath, batchId),
  );
  ipcMain.handle('engine:runPerformance', (_e, projectPath: string) =>
    withDomainScore(projectPath, () => runPerformanceHandler(manager, projectPath)),
  );
  ipcMain.handle('engine:runRefactor', (_e, projectPath: string) =>
    withDomainScore(projectPath, () => runRefactorHandler(manager, projectPath)),
  );
  ipcMain.handle('engine:runDeps', async (_e, projectPath: string) => {
    const task = manager.start('deps', projectPath);
    return withDomainScore(
      projectPath,
      async () => (await manager.waitFor(task.id)) as DependencyReportData,
    );
  });
  ipcMain.handle('engine:depsRelockBaseline', (_e, projectPath: string) =>
    depsRelockBaselineHandler(projectPath),
  );
  ipcMain.handle('engine:runTechDebt', async (_e, projectPath: string) => {
    const task = manager.start('techdebt', projectPath);
    return withDomainScore(
      projectPath,
      async () => (await manager.waitFor(task.id)) as TechDebtReportData,
    );
  });
}

/** 技术债行动与密钥生命周期：不依赖 TaskManager，纯落库动作 */
function registerDebtAndSecretHandlers(): void {
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
}

/** 查询与报告通道：分数 / 历史 / 落盘报告 / 快照 / 画像 / 汇总，全部只读（除 save 与 pipeline） */
function registerEngineQueryHandlers(manager: TaskManager): void {
  ipcMain.handle(
    'engine:runPipeline',
    (_e, projectPath: string, options?: { dryRun?: boolean; sop?: boolean }) =>
      runPipelineHandler(manager, projectPath, options),
  );
  ipcMain.handle('engine:getScore', getScoreHandler);
  ipcMain.handle('engine:getScoreHistory', getScoreHistoryHandler);
  ipcMain.handle('engine:getDomainScore', getDomainScoreHandler);
  // 报告中心总览实时视图：十维一次取齐（与分类页同源），只读不落库
  ipcMain.handle('engine:getHealthOverview', getHealthOverviewHandler);
  // 读该域最近一次落盘快照（仅问题项）：供分类页「有历史结果即可查看详情」
  ipcMain.handle('engine:getDomainReport', getDomainReportHandler);
  // 各域「完整报告」落盘 / 读回：详情页可原样回看上次结果（不靠内存 report）
  ipcMain.handle('engine:saveDomainReport', saveDomainReportHandler);
  ipcMain.handle('engine:getSavedDomainReport', getSavedDomainReportHandler);
  // 原样读回归一化快照（评分赖以计算的那份）：旧数据的唯一可回看内容
  ipcMain.handle('engine:getDomainSnapshotRaw', getDomainSnapshotRawHandler);
  // 该域是否跑过（完整报告 or 归一化快照任一存在）：决定「详情入口」是否可见
  ipcMain.handle('engine:hasDomainResult', hasDomainResultHandler);
  // 域级扫描历史：每次扫描一条（含分数/问题数/指纹集），供「涨了还是跌了」与趋势回溯
  ipcMain.handle('engine:listDomainHistory', listDomainHistoryHandler);
  ipcMain.handle('engine:getDomainScanBlob', getDomainScanBlobHandler);
  ipcMain.handle('engine:getLatestDomainScan', getLatestDomainScanHandler);
  ipcMain.handle('engine:getProfile', getProfileHandler);
  ipcMain.handle('engine:runProfile', (_e, projectPath: string) => runProfileHandler(projectPath));
  // 报告中心：只读汇总各域最新结果并落库（不发起检查；无结果时返回 null）
  ipcMain.handle('engine:generateReportSummary', (_e, projectPath: string) =>
    generateReportSummaryHandler(projectPath),
  );
}

export function registerEnginesIpc(manager: TaskManager): void {
  // 三组按原注册顺序依次挂载；通道名与 handler 的对应关系不变
  registerEngineRunHandlers(manager);
  registerDebtAndSecretHandlers();
  registerEngineQueryHandlers(manager);
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
    rethrowIfCancelled(err); // 用户点「停止」不是失败：原样抛给渲染层静默处理
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
    rethrowIfCancelled(err); // 用户点「停止」不是失败：原样抛给渲染层静默处理
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
    rethrowIfCancelled(err); // 用户点「停止」不是失败：原样抛给渲染层静默处理
    console.error('[engine:runPerformance] Error:', err);
    return {
      summary: { total: 0, autoFixable: 0 },
      issues: [],
      metadata: { duration: 0, timestamp: new Date().toISOString() },
    };
  }
}

async function runPipelineHandler(
  manager: TaskManager,
  projectPath: string,
  options?: { dryRun?: boolean; sop?: boolean; origin?: 'auto' },
): Promise<PipelineReport> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    // origin（触发来源）必须从 request 里剥掉：它不参与去重请求键，
    // 否则自动巡检 {sop,origin:'auto'} 与手动一键体检 {sop} 会被当成两个任务，
    // 用户手动点击时不再复用自动任务，反而排出一个重复扫描。
    const { origin, ...request } = options ?? {};
    const task = manager.start('pipeline', projectPath, request, { origin });
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
    rethrowIfCancelled(err); // 用户点「停止」不是失败：原样抛给渲染层静默处理
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
