/**
 * 治理引擎 IPC（ipc/engines.ts）
 *
 * Guard / Inspect / Security / Refactor / Pipeline / Scoring 全部走子进程执行，
 * 主进程仅转发与转换报告；体检发现问题后自动触发 opencode CLI 修复（非阻塞）。
 */

import { ipcMain } from 'electron';
import path from 'node:path';
import { constants as FS_CONSTANTS } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { t } from '@zh/i18n';

import {
  buildHealthDimensions,
  buildTechDebtDashboard,
  computeRedLine,
  mergeActionStatuses,
  computeTrendDelta,
  scoreProjectByModules,
} from '@zh/scoring';
import type {
  DebtIssueInput,
  ModuleHotnessInput,
  ConvertedGuardResult,
  ConvertedInspectIssue,
} from '@zh/scoring';
import type { CheckOptions, GuardReport } from '@zh/guard';
import { appendGuardReport, listGuardReports, toGuardReportRecord } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { SecurityScanReport } from '@zh/security';
import type { GarbageScanReport, GarbageCleanResult, GarbageRestoreResult } from '@zh/garbage';
import { SecretLifecycleManager, FileSecretStore } from '@zh/security';
import type { RefactorReport } from '@zh/refactor';
import { createReport, type PipelineReport, type ProjectProfile } from '@zh/pipeline';
import { type ScoringProjectProfile } from '@zh/fingerprint';
import {
  convertGuardEvaluations,
  convertInspectEvaluations,
  convertTraditionalGuardResults,
} from './score-converters';
import { loadBackupHealthSnapshot } from './backup';
import { getSentinelHealthData } from './sentinel';
import {
  loadDepsBaseline,
  saveDepsBaseline,
  integritySnapshot,
  extractMismatchedNodeIds,
  applyMismatchedTrust,
} from './deps-baseline';
import {
  buildDependencyGraph,
  buildLicenseMatrix,
  lockfileVerifier,
  resolveProjectRoot,
  TyposquatDetectorImpl,
  UpgradeEvaluatorImpl,
  EnvConsistencyCheckerImpl,
  DEFAULT_UPGRADE_CATALOG,
} from '@zh/dependency';
import type {
  DependencyNode,
  DependencyGraph,
  TyposquatFinding,
  LockfileVerification,
  UpgradeAssessment,
  EnvEntry,
} from '@zh/dependency';
import {
  saveDebtAction,
  updateDebtActionStatus,
  getDebtActionsByProject,
  saveDebtSnapshot,
  getLatestDebtSnapshot,
} from '@zh/db';

import {
  persistDiagnostics,
  persistDiagnosticsFromEntries,
  normalizeGuardSource,
  normalizeRefactorSource,
  normalizePerformanceData,
  normalizeDepsSource,
  normalizeTechDebtSource,
  normalizeSecuritySource,
  readDomainSnapshot,
} from '../zh-diagnostics';
import {
  readDashboardState,
  updateDashboardState,
  type DashboardDepsState,
  type DashboardRefactorState,
  type DashboardPerformanceState,
  type DashboardGarbageState,
} from './dashboard-state';
import {
  shouldAutoFix,
  countFixableIssues,
  buildFixPrompt,
  resolveOpenCodeBin,
  resolveOpenCodeModel,
} from '../ai-auto-fix';
import {
  getScoring,
  getDb,
  sendProgress,
  setCachedProfile,
  registerProjectFeaturesToCloud,
  type CachedProjectFeature,
} from '../ipc-context';
import {
  collectExposedFilesInWorker,
  detectProfileInWorker,
  runProfileInWorker,
  runProfileSyncInWorker,
} from '../profile-host';
import type { TaskManager } from '../task-manager';
import {
  toGuardReportData,
  toSecurityScanReportData,
  toHealthScoreData,
  type GuardReportData,
  type SecurityScanReportData,
  type PerformanceReportData,
  type HealthScoreData,
} from './report-format';
import type {
  DependencyReportData,
  TechDebtReportData,
  SecretReportData,
  ProjectProfileData,
  DepsRelockResult,
  DomainScoreData,
} from '../../src/types/electron';
import {
  toGuardChecks,
  toInspectIssues,
  hasAnyExtraResult,
  type PipelineExtras,
} from '../report-summary';

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, FS_CONSTANTS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 读取诊断报告并解析为可判定 JSON */
async function readDiagnosticsReport(diagnosticsPath: string): Promise<{
  summary: { error: number; warning: number };
  issues?: Array<{ source?: string; severity?: string }>;
}> {
  const raw = await readFile(diagnosticsPath, 'utf-8');
  return JSON.parse(raw) as {
    summary: { error: number; warning: number };
    issues?: Array<{ source?: string; severity?: string }>;
  };
}

/** 收集 opencode CLI 候选路径：环境变量 / PATH / ~/.local/bin */
async function collectOpenCodeCandidates(): Promise<Array<{ path: string; executable: boolean }>> {
  const envBin = process.env.ZH_OPENCODE_BIN;
  const candidates: Array<{ path: string; executable: boolean }> = [];
  if (envBin) {
    candidates.push({ path: envBin, executable: await isExecutable(envBin) });
  }
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const p = path.join(dir, 'opencode');
    // eslint-disable-next-line perf/perf-no-serial-await -- p derived from loop var dir via intermediate assignment
    candidates.push({ path: p, executable: await isExecutable(p) });
  }
  const homeLocalBin = path.join(os.homedir(), '.local', 'bin', 'opencode');
  if (!candidates.some((c) => c.path === homeLocalBin)) {
    candidates.push({ path: homeLocalBin, executable: await isExecutable(homeLocalBin) });
  }
  return candidates;
}

/** 以 detached 方式启动 opencode 修复进程，仅记录日志与进度，不阻塞主进程 */
function spawnOpenCodeFix(
  bin: string,
  projectPath: string,
  fixableError: number,
  fixableWarning: number,
): void {
  const model = resolveOpenCodeModel(process.env.ZH_OPENCODE_MODEL);
  const child = spawn(
    bin,
    ['run', '-m', model, '--dir', projectPath, buildFixPrompt(projectPath)],
    {
      stdio: 'ignore',
      detached: true,
    },
  );
  child.on('error', (err) => console.warn('[ai:autofix] 启动 opencode 失败:', err.message));
  child.on('exit', (code) =>
    console.log(`[ai:autofix] opencode 修复进程退出，code=${code ?? 'null'}`),
  );
  child.unref();
  sendProgress(
    'autofix',
    t('pipeline.autofix.started', { errors: fixableError, warnings: fixableWarning }),
    1,
  );
}

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

/** 模块级独立评分：跳过根级兜底卡（path === projectPath），各模块用自身类型权重评分后逐模块落库 */
function scoreProjectModules(
  scoring: Awaited<ReturnType<typeof getScoring>>,
  aggregate: ReturnType<typeof scoreProjectByModules>,
  projectPath: string,
): void {
  for (const card of aggregate.modules) {
    if (card.path === projectPath) continue;
    const moduleScore = scoring.calculate(card.path, card.dimensions);
    console.log(
      `[engine:runPipeline] 模块评分已落库: ${card.path} ${moduleScore.overall} (${moduleScore.grade})`,
    );
  }
}

/** 解析评分输入的报告格式：SOP/传统；缺报告或格式混合时跳过评分（返回 null） */
type ResolvedPipelineReports = {
  isSop: boolean;
  guardResults: ConvertedGuardResult[];
  inspectIssues: ConvertedInspectIssue[];
};

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

/** 探测项目画像，失败时降级为 null（采用默认评分配置） */
async function probeProjectProfile(projectPath: string): Promise<ScoringProjectProfile | null> {
  try {
    const profile = (await runProfileSyncInWorker(projectPath)).profile;
    cacheProfile(profile, projectPath);
    return profile;
  } catch (err) {
    console.warn(
      '[engine:runPipeline] 画像探测失败，降级默认评分配置:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** 将探测到的项目画像投影为 kernel 兼容的 ProjectFeature 并写入画像缓存（供工具规则按画像裁剪） */
function cacheProfile(profile: ScoringProjectProfile, projectPath?: string): void {
  const feature: CachedProjectFeature = {
    language: profile.language === 'unknown' ? undefined : profile.language,
    framework: profile.framework,
    features: [],
  };
  setCachedProfile(feature, projectPath);
  if (projectPath) {
    void registerProjectFeaturesToCloud(feature, projectPath);
  }
}

/**
 * 写分点 1/2：体检完成后将 guard + inspect 报告转化为健康维度分并落库。
 *
 * 🔴 落分口径铁律（T14）：健康总分在全仓**只有两个写分点** ——
 *   ① 本函数：消费刚跑完的 PipelineReport（真实发起检查后落分）
 *   ② `generateReportSummaryHandler`：只读各域最近落盘结果汇总（报告中心）
 * 两者必须共用 `buildHealthDimensions` + `ScoringEngine.calculate`，
 * 否则同一时刻两条路径会写出两个分，历史趋势断裂。
 * 另：总分是**对已有结果的汇总**而非实时值，UI 侧由 `scoreFreshness` 标注数据时间。
 *
 * 支持两种报告格式：
 * 1. 传统格式：GuardReport（有 results）+ InspectionReport（有 issues）
 * 2. SOP 格式：RuleEngineReport（有 evaluations）— 需要转换
 */
async function recordPipelineScore(projectPath: string, report: PipelineReport): Promise<void> {
  try {
    const resolved = resolvePipelineReports(report);
    if (!resolved) return;

    const scoring = await getScoring();
    const profilingResult = await probeProjectProfile(projectPath);
    // P1b: 从 dashboard-state.json 读取 secrets/deps/techdebt/refactor/performance 最新数据组装 extras，
    // 传入 buildHealthDimensions 第 5 参（DimensionExtras 契约），保证 pipeline 分与 dashboard 分一致。
    const extras = await buildPipelineExtras(projectPath);
    const dimensions = buildHealthDimensions(
      { results: resolved.guardResults },
      { issues: resolved.inspectIssues },
      projectPath,
      profilingResult,
      extras,
    );
    const score = scoring.calculate(projectPath, dimensions, computeRedLine(extras));
    console.log(`[engine:runPipeline] 健康评分已落库: ${score.overall} (${score.grade})`);

    if (profilingResult?.modules?.length) {
      const moduleGuardResults = resolved.isSop
        ? resolved.guardResults
        : convertTraditionalGuardResults((report.guard as GuardReport).results);
      const aggregate = scoreProjectByModules(
        profilingResult,
        { results: moduleGuardResults },
        { issues: resolved.inspectIssues },
      );
      scoreProjectModules(scoring, aggregate, projectPath);
    }
  } catch (err) {
    console.warn(
      '[engine:runPipeline] 健康评分落库失败:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─── 报告中心：只读汇总（不发起任何检查）──────────────────────────────

/**
 * 写分点 2/2：报告中心「汇总生成报告」——只读各域最新落盘结果，按统一维度加权算健康总分并落库。
 *
 * 与 recordPipelineScore 唯一的区别是数据来源：
 * - recordPipelineScore 消费刚跑完的 PipelineReport（由 pipeline 触发）；
 * - 本函数消费 guard 报告记录 + .zhshield/diagnostics/domains/inspect.json +
 *   dashboard-state.json，**纯只读，不触发任何扫描**。
 * 评分算法（buildHealthDimensions + ScoringEngine.calculate）完整复用，
 * 保证两条路径写出的分数同口径、历史趋势连续。
 *
 * 各域都没有可用结果时返回 null，由 UI 提示「先运行检查」——
 * 不写一条 0 分记录污染历史（未检测 ≠ 0 分）。
 */
async function generateReportSummaryHandler(projectPath: string): Promise<HealthScoreData | null> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    // gate 维度取自 guard 报告记录（含通过项，与 pipeline 口径一致）：
    // listGuardReports 返回新→旧，取 [0] 即最近一次门禁结果。
    const guardRecord = listGuardReports(projectPath)[0] ?? null;
    const inspectSnapshot = await readDomainSnapshot(projectPath, 'inspect');
    const extras = await buildPipelineExtras(projectPath);
    const hasResults =
      guardRecord !== null || inspectSnapshot !== null || hasAnyExtraResult(extras);
    if (!hasResults) return null;

    const scoring = await getScoring();
    const profilingResult = await probeProjectProfile(projectPath);
    const dimensions = buildHealthDimensions(
      guardRecord ? { results: toGuardChecks(guardRecord.checks) } : null,
      inspectSnapshot ? { issues: toInspectIssues(inspectSnapshot.issues) } : null,
      projectPath,
      profilingResult,
      extras,
    );
    const score = scoring.calculate(projectPath, dimensions, computeRedLine(extras));
    console.log(`[engine:generateReportSummary] 汇总评分已落库: ${score.overall} (${score.grade})`);
    return toHealthScoreData(score);
  } catch (err) {
    console.warn(
      '[engine:generateReportSummary] 汇总失败:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
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
  ipcMain.handle(
    'engine:garbageClean',
    (
      _e,
      projectPath: string,
      items: Array<{ id: string; path: string; size: number; type: string }>,
    ) => garbageCleanHandler(manager, projectPath, items),
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

async function runSecurityHandler(
  manager: TaskManager,
  projectPath: string,
): Promise<SecurityScanReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const task = manager.start('security', projectPath);
    const report = (await manager.waitFor(task.id)) as SecurityScanReport;
    const data = toSecurityScanReportData(report);
    try {
      await persistDiagnosticsFromEntries(projectPath, normalizeSecuritySource(data), ['security']);
    } catch (e) {
      console.warn(
        '[engine:runSecurity] 诊断落盘失败:',
        e instanceof Error ? e.message : String(e),
      );
    }
    return data;
  } catch (err) {
    console.error('[engine:runSecurity] Error:', err);
    return {
      summary: {
        total: 0,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        malwareTotal: 0,
      },
      findings: [],
      malware: [],
      securityScore: 100,
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

async function garbageCleanHandler(
  manager: TaskManager,
  projectPath: string,
  items: Array<{ id: string; path: string; size: number; type: string }>,
): Promise<GarbageCleanResult> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const task = manager.start('garbageClean', projectPath, { items });
    const result = (await manager.waitFor(task.id)) as GarbageCleanResult;
    // 十域评分：清理完成后按已清理条目递减 dashboard-state 里的 garbage 计数
    try {
      const state = await readDashboardState(projectPath);
      if (state.garbage) {
        const byType: Record<string, number> = { ...state.garbage.byType };
        let total = state.garbage.total;
        for (const item of result.cleaned ?? []) {
          const type = String((item as { type?: unknown }).type ?? '');
          if (type && byType[type] !== undefined) byType[type] = Math.max(0, byType[type] - 1);
          total = Math.max(0, total - 1);
        }
        await updateDashboardState(projectPath, {
          garbage: { total, byType, lastRunAt: new Date().toISOString() },
        });
      }
    } catch (e) {
      console.warn(
        '[engine:garbageClean] dashboard-state 更新失败:',
        e instanceof Error ? e.message : String(e),
      );
    }
    return result;
  } catch (err) {
    console.error('[engine:garbageClean] Error:', err);
    return { batchId: '', cleaned: [], freedBytes: 0, failed: [t('electron.cleanFailed')] };
  }
}

async function garbageRestoreHandler(
  manager: TaskManager,
  projectPath: string,
  batchId: string,
): Promise<GarbageRestoreResult> {
  try {
    if (
      !projectPath ||
      typeof projectPath !== 'string' ||
      !batchId ||
      typeof batchId !== 'string'
    ) {
      throw new Error(t('electron.invalidParams'));
    }
    const task = manager.start('garbageRestore', projectPath, { batchId });
    const result = (await manager.waitFor(task.id)) as GarbageRestoreResult;
    return result;
  } catch (err) {
    console.error('[engine:garbageRestore] Error:', err);
    return { restored: 0, restoredBytes: 0, failed: [t('electron.restoreFailed')] };
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
        'inspect',
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

async function runRefactorHandler(
  manager: TaskManager,
  projectPath: string,
): Promise<RefactorReport> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    // 重构分析含同步扫盘 + AST，必须离主进程，否则 macOS 彩球
    const task = manager.start('refactor', projectPath);
    const report = (await manager.waitFor(task.id)) as RefactorReport;
    try {
      await persistDiagnosticsFromEntries(projectPath, normalizeRefactorSource(report), [
        'refactor',
      ]);
    } catch (e) {
      console.warn(
        '[engine:runRefactor] 诊断落盘失败:',
        e instanceof Error ? e.message : String(e),
      );
    }
    // P1b: 补写 dashboard-state refactor 域（异味总数 + severity 分布 + lastRunAt）
    await updateDashboardState(projectPath, { refactor: refactorDashboardPatch(report) });
    return report;
  } catch (err) {
    console.error('[engine:runRefactor] Error:', err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** 按信任状态统计节点数（verified / suspicious / compromised / unknown） */
function countTrustCounts(nodes: DependencyNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    counts[node.trust] = (counts[node.trust] ?? 0) + 1;
  }
  return counts;
}

/** 依赖管家失败时的空报告（error 携带失败原因，不 throw） */
function emptyDepsReport(error: string): DependencyReportData {
  return {
    schemaVersion: 0,
    targetId: '',
    ecosystem: 'mixed',
    direct: 0,
    transitive: 0,
    total: 0,
    edgeCount: 0,
    lockfile: { present: false, consistent: false, integrityVerified: false },
    trustCounts: {},
    licenseMatrix: { total: 0, byCategory: {}, entries: [] },
    typosquatFindings: [],
    lockfileVerification: { status: 'missing', diffs: [], integrityFailures: [] },
    upgradeAssessments: [],
    envEntries: [],
    generatedAt: new Date().toISOString(),
    error,
  };
}

/**
 * 从 DependencyReportData 提取 deps 域 dashboard-state patch。
 *
 * 漏洞计数提取口径（DependencyReportData 无精确 severity 字段，取最接近语义的字段）：
 * - critical = trustCounts.compromised ?? 0（被攻陷依赖节点，最高安全风险）
 * - high = trustCounts.suspicious ?? 0（可疑依赖节点，高安全风险）
 * - medium = typosquatFindings 中 risk='medium' 的投毒发现数（中等投毒风险）
 * - upgradable = upgradeAssessments 中 candidates.length > 0 的依赖数（可升级依赖）
 */
function depsDashboardPatch(report: DependencyReportData): DashboardDepsState {
  const typosquatMedium = report.typosquatFindings.filter((f) => f.risk === 'medium').length;
  const upgradable = report.upgradeAssessments.filter((a) => a.candidates.length > 0).length;
  return {
    vulnerabilities: {
      critical: report.trustCounts.compromised ?? 0,
      high: report.trustCounts.suspicious ?? 0,
      medium: typosquatMedium,
    },
    upgradable,
    lastRunAt: new Date().toISOString(),
  };
}

/** 从 RefactorReport 提取 refactor 域 dashboard-state patch */
function refactorDashboardPatch(report: RefactorReport): DashboardRefactorState {
  const bySeverity = {
    error: report.bySeverity.error ?? 0,
    warning: report.bySeverity.warning ?? 0,
    info: report.bySeverity.info ?? 0,
  };
  return { totalSmells: report.totalSmells, bySeverity, lastRunAt: new Date().toISOString() };
}

/** 从 PerformanceReportData 提取 performance 域 dashboard-state patch */
function performanceDashboardPatch(report: PerformanceReportData): DashboardPerformanceState {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const issue of report.issues) {
    const key = issue.severity as keyof typeof counts;
    if (key in counts) counts[key]++;
  }
  return { total: report.summary.total, bySeverity: counts, lastRunAt: new Date().toISOString() };
}

/** 从 GarbageScanReport 提取 garbage 域 dashboard-state patch（十域评分章程 #5） */
function garbageDashboardPatch(report: GarbageScanReport): DashboardGarbageState {
  return {
    total: report.summary.total,
    byType: { ...report.summary.byType },
    lastRunAt: new Date().toISOString(),
  };
}

// ─── 仪表盘聚合（P1b）─────────────────────────────────────────────

/** 从 dashboard-state.json + 哨兵事件中心 + 备份记录组装 extras（无对应域时传 null） */
async function buildPipelineExtras(projectPath: string): Promise<PipelineExtras> {
  const state = await readDashboardState(projectPath);
  const [sentinel, backup] = await Promise.all([
    getSentinelHealthData(projectPath).catch(() => null),
    loadBackupHealthSnapshot(projectPath).catch(() => null),
  ]);
  return {
    secrets: state.secrets ? { activeCount: state.secrets.activeCount } : null,
    deps: state.deps
      ? { vulnerabilities: state.deps.vulnerabilities, upgradable: state.deps.upgradable }
      : null,
    techdebt: state.techdebt
      ? { debtIndex: state.techdebt.debtIndex, issueCount: state.techdebt.issueCount }
      : null,
    refactor: state.refactor
      ? { totalSmells: state.refactor.totalSmells, bySeverity: state.refactor.bySeverity }
      : null,
    performance: state.performance
      ? { total: state.performance.total, bySeverity: state.performance.bySeverity }
      : null,
    garbage: state.garbage
      ? { total: state.garbage.total, byType: state.garbage.byType }
      : null,
    sentinel,
    backup,
  };
}

/**
 * 依赖管家（engine:runDeps）：纯静态解析锁文件/清单，直连主进程，
 * 不经 TaskManager / worker。返回依赖图谱 + 许可证矩阵 + 投毒检测 +
 * 锁文件校验 + 升级评估 + 环境一致性报告。
 */
async function runDepsHandler(projectPath: string): Promise<DependencyReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const projectRoot = resolveProjectRoot(projectPath);
    const baseline = await loadDepsBaseline(projectRoot);
    const graph = buildDependencyGraph(projectRoot);
    const matrix = buildLicenseMatrix(graph);
    let nodes = graph.nodes;
    const [typosquat, lockfileCheck, upgrade, env] = await Promise.all([
      runTyposquatChecks(graph),
      runLockfileChecks(projectRoot, baseline?.integrity),
      runUpgradeChecks(nodes),
      runEnvConsistencyChecks(projectRoot),
    ]);
    // 与基线哈希不符的节点 → 最高危 trust（须在 countTrustCounts 之前覆盖；浅拷贝替换，不原地改）
    // mismatchedNodeIds 由 verify() 的 actual !== undefined 语义保证：仅同版本哈希真实改变才命中，
    // 升级（版本号变化）天然免疫，不误报。
    nodes = applyMismatchedTrust(nodes, lockfileCheck.mismatchedNodeIds);
    // 首次盘点（无基线）且校验 clean → 自动建基线（幂等；后续仅显式 relock 更新）
    if (!baseline && lockfileCheck.verification.status === 'clean') {
      await saveDepsBaseline(projectRoot, integritySnapshot(nodes));
    }
    const report: DependencyReportData = {
      schemaVersion: graph.schemaVersion,
      targetId: graph.targetId,
      ecosystem: graph.ecosystem,
      direct: nodes.filter((node: { kind: string }) => node.kind === 'direct').length,
      transitive: nodes.filter((node: { kind: string }) => node.kind === 'transitive').length,
      total: nodes.length,
      edgeCount: graph.edges.length,
      lockfile: graph.lockfile,
      trustCounts: countTrustCounts(nodes),
      licenseMatrix: matrix,
      generatedAt: graph.generatedAt,
      error: null,
      typosquatFindings: typosquat.findings,
      lockfileVerification: lockfileCheck.verification,
      upgradeAssessments: upgrade.assessments,
      envEntries: env.entries,
      ...(typosquat.error ? { typosquatError: typosquat.error } : {}),
      ...(lockfileCheck.error ? { lockfileError: lockfileCheck.error } : {}),
      ...(upgrade.error ? { upgradeError: upgrade.error } : {}),
      ...(env.error ? { envError: env.error } : {}),
    };
    try {
      await persistDiagnosticsFromEntries(projectPath, normalizeDepsSource(report), ['deps']);
    } catch (e) {
      console.warn('[engine:runDeps] 诊断落盘失败:', e instanceof Error ? e.message : String(e));
    }
    // P1b: 补写 dashboard-state deps 域（漏洞 severity 计数 + 可升级数 + lastRunAt）
    await updateDashboardState(projectPath, { deps: depsDashboardPatch(report) });
    return report;
  } catch (err) {
    console.error('[engine:runDeps] Error:', err);
    return emptyDepsReport(err instanceof Error ? err.message : String(err));
  }
}

/** 显式重锁基线：仅当锁文件哈希完整（integrityVerified，全部节点带哈希）时才允许，防止把残缺哈希锁成基线 */
async function depsRelockBaselineHandler(projectPath: string): Promise<DepsRelockResult> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const projectRoot = resolveProjectRoot(projectPath);
    const graph = buildDependencyGraph(projectRoot);
    if (!graph.lockfile.integrityVerified) {
      return { ok: false, error: t('electron.depsRelock.integrityIncomplete') };
    }
    await saveDepsBaseline(projectRoot, integritySnapshot(graph.nodes));
    return { ok: true };
  } catch (err) {
    console.error('[engine:depsRelockBaseline] Error:', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 投毒检测接线：单适配器失败 → 空数组 + error，不阻断整个盘点 */
async function runTyposquatChecks(
  graph: DependencyGraph,
): Promise<{ findings: TyposquatFinding[]; error?: string }> {
  try {
    const detector = new TyposquatDetectorImpl();
    return { findings: await detector.detect(graph) };
  } catch (err) {
    console.warn(
      '[engine:runDeps] 投毒检测失败:',
      err instanceof Error ? err.message : String(err),
    );
    return { findings: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 锁文件完整性校验接线：校验器契约不抛异常，兜底为 missing + error；返回与基线哈希不符的节点 id 列表 */
async function runLockfileChecks(
  projectPath: string,
  expectedIntegrity?: Record<string, string>,
): Promise<{ verification: LockfileVerification; mismatchedNodeIds: string[]; error?: string }> {
  try {
    const verification = await lockfileVerifier.verify(
      projectPath,
      expectedIntegrity ? { expectedIntegrity } : undefined,
    );
    return {
      verification,
      mismatchedNodeIds: extractMismatchedNodeIds(verification.integrityFailures),
    };
  } catch (err) {
    console.warn(
      '[engine:runDeps] 锁文件校验失败:',
      err instanceof Error ? err.message : String(err),
    );
    return {
      verification: { status: 'missing', diffs: [], integrityFailures: [] },
      mismatchedNodeIds: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 升级评估接线：仅 direct 依赖且命中内置升级目录，不做 code-scan 防主进程阻塞 */
async function runUpgradeChecks(
  nodes: readonly DependencyNode[],
): Promise<{ assessments: UpgradeAssessment[]; error?: string }> {
  try {
    const evaluator = new UpgradeEvaluatorImpl();
    const directNodes = nodes.filter(
      (node) => node.kind === 'direct' && node.name in DEFAULT_UPGRADE_CATALOG,
    );
    const assessments: UpgradeAssessment[] = [];
    for (const node of directNodes) {
      assessments.push(await evaluator.evaluate(node));
    }
    return { assessments };
  } catch (err) {
    console.warn(
      '[engine:runDeps] 升级评估失败:',
      err instanceof Error ? err.message : String(err),
    );
    return { assessments: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 环境一致性检查接线：从 projectPath 推导 ProjectProfile（detectProjectProfile 同步 fs，移入 profile worker 执行） */
async function runEnvConsistencyChecks(
  projectPath: string,
): Promise<{ entries: EnvEntry[]; error?: string }> {
  try {
    const checker = new EnvConsistencyCheckerImpl();
    const profile = (await detectProfileInWorker(projectPath)) as ProjectProfile;
    const report = await checker.check(profile);
    return { entries: report.entries };
  } catch (err) {
    console.warn(
      '[engine:runDeps] 环境一致性检查失败:',
      err instanceof Error ? err.message : String(err),
    );
    return { entries: [], error: err instanceof Error ? err.message : String(err) };
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

/**
 * 统计项目近 90 天模块热度：只读 `git log --since=90.days --name-only`，
 * 按文件路径去重计数提交出现次数。git 不可用 / 非 git 仓库 → 空数组。
 */
function collectModuleHotness(projectPath: string): Promise<ModuleHotnessInput[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['log', '--since=90.days', '--pretty=format:', '--name-only'],
      { cwd: projectPath, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.warn('[engine:runTechDebt] git log 失败，模块热度置空:', err.message);
          resolve([]);
          return;
        }
        const counts = new Map<string, number>();
        for (const raw of stdout.split('\n')) {
          const file = raw.trim();
          if (!file) continue;
          counts.set(file, (counts.get(file) ?? 0) + 1);
        }
        const hotness = Array.from(counts.entries(), ([module, commitCount]) => ({
          module,
          commitCount,
        })).sort((a, b) => b.commitCount - a.commitCount);
        resolve(hotness);
      },
    );
  });
}

/**
 * 技术债的输入来自 **inspect 域最近一次落盘快照**（只读，不发起检查）。
 *
 * 背景（T6）：`runTechDebt` / `planDebtRepayment` / `verifyDebtRepaid` 三处此前都直接
 * `runInspectTask()` —— 打开技术债页、计划还款、验证还款，各触发一次 11 工具完整巡检。
 * 这违反「触发权域内独占」：技术债只是**消费**巡检结论并叠加 git 热度算出 ROI，
 * 判定权不在它手里。
 *
 * 跨域消费的正确写法是「只读结果，不发起检查」：读 `.zhshield/diagnostics/domains/inspect.json`
 * （由 inspect 域自己落盘，按域分文件，不被其他域覆盖写清掉）。
 *
 * projectId 沿用 `InspectionReport.projectId` 的口径 —— 那是 `path.resolve(projectPath)`
 * 后的**绝对路径**（inspect/src/engine.ts 归一化），且 @zh/db 的债务快照/动作表都以它为键。
 * **不可**换成 hash 型 projectId，否则历史趋势与动作状态会静默失联。
 */
type DebtInputResult =
  | { ok: true; projectId: string; issues: DebtIssueInput[]; generatedAt: string }
  | { ok: false; reason: 'no-snapshot' };

async function loadDebtInputFromSnapshot(projectPath: string): Promise<DebtInputResult> {
  const snapshot = await readDomainSnapshot(projectPath, 'inspect');
  if (!snapshot) return { ok: false, reason: 'no-snapshot' };
  return {
    ok: true,
    projectId: path.resolve(projectPath),
    generatedAt: snapshot.generatedAt,
    issues: snapshot.issues.map((entry) => ({
      id: entry.fingerprint,
      severity: entry.severity,
      category: entry.category,
      file: entry.file,
    })),
  };
}

/**
 * 技术债仪表盘（engine:runTechDebt）：直连主进程，不注册 TaskManager 任务类型。
 * 读 inspect 域落盘快照（只读），叠加 git 模块热度 + 对外接口清单，
 * 由 @zh/scoring buildTechDebtDashboard 生成 ROI 排序报告。
 * 无快照时返回带 error 的空报告（显式提示先跑体检），不静默显示 0 债务。
 */
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
    const moduleHotness = await collectModuleHotness(projectPath);
    const exposedFiles = await collectExposedFilesInWorker(projectPath);
    const snapshot = buildTechDebtDashboard({
      projectId: input.projectId,
      issues: input.issues,
      moduleHotness,
      exposedFiles,
    });
    let finalSnapshot = snapshot;
    try {
      const db = getDb();
      const projectId = snapshot.projectId;
      const persisted = getDebtActionsByProject(db, projectId);
      finalSnapshot = {
        ...snapshot,
        actionList: mergeActionStatuses(
          snapshot.actionList,
          persisted.map((row) => ({ actionId: row.action_id, status: row.status })),
        ),
      };
      const previous = getLatestDebtSnapshot(db, projectId);
      finalSnapshot = {
        ...finalSnapshot,
        trend: {
          ...finalSnapshot.trend,
          delta: computeTrendDelta(snapshot.debtIndex, previous ? previous.debt_index : null),
        },
      };
      saveDebtSnapshot(db, { projectId, debtIndex: snapshot.debtIndex });
    } catch (err) {
      console.warn(
        '[engine:runTechDebt] 债务状态持久化不可用，降级为纯计算:',
        err instanceof Error ? err.message : String(err),
      );
    }
    const report: TechDebtReportData = { ...finalSnapshot, error: null };
    try {
      await persistDiagnosticsFromEntries(projectPath, normalizeTechDebtSource(report), [
        'techdebt',
      ]);
    } catch (e) {
      console.warn(
        '[engine:runTechDebt] 诊断落盘失败:',
        e instanceof Error ? e.message : String(e),
      );
    }
    // P1b: 补写 dashboard-state techdebt 域（debtIndex + 动作数 + lastRunAt）
    await updateDashboardState(projectPath, {
      techdebt: {
        debtIndex: report.debtIndex,
        issueCount: report.actionList.length,
        lastRunAt: new Date().toISOString(),
      },
    });
    return report;
  } catch (err) {
    console.error('[engine:runTechDebt] Error:', err);
    return emptyTechDebtReport(err instanceof Error ? err.message : String(err));
  }
}

async function planDebtRepaymentHandler(
  projectPath: string,
  actionId: string,
  opts?: { sprint?: string; gate?: 'allow-with-record' },
): Promise<void> {
  try {
    if (
      !projectPath ||
      typeof projectPath !== 'string' ||
      !actionId ||
      typeof actionId !== 'string'
    ) {
      throw new Error(t('electron.invalidProjectPath'));
    }
    // 只读快照：这里的 action 本来就取自同一份快照（页面渲染用的就是它），
    // 读快照比重新全量巡检更一致，也避免「点还款又跑一次 11 工具」。
    const input = await loadDebtInputFromSnapshot(projectPath);
    if (!input.ok) {
      console.warn('[engine:debt:planRepayment] 无 inspect 域快照，请先运行项目体检');
      return;
    }
    const moduleHotness = await collectModuleHotness(projectPath);
    const exposedFiles = await collectExposedFilesInWorker(projectPath);
    const snapshot = buildTechDebtDashboard({
      projectId: input.projectId,
      issues: input.issues,
      moduleHotness,
      exposedFiles,
    });
    const action = snapshot.actionList.find((a) => a.actionId === actionId);
    if (!action) {
      console.warn(`[engine:debt:planRepayment] action 未找到: ${actionId}`);
      return;
    }
    const db = getDb();
    saveDebtAction(db, {
      projectId: snapshot.projectId,
      actionId,
      status: 'planned',
      module: action.module,
      category: action.category,
      issueIds: action.issueIds,
      interestScore: action.interestScore,
      principalEstimate: action.principalEstimate,
      roi: action.roi,
      sprint: opts?.sprint ?? undefined,
      gate: opts?.gate ?? undefined,
    });
  } catch (err) {
    console.warn(
      '[engine:debt:planRepayment] 计划偿还失败:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 验证还款：按 inspect 域最新落盘快照判定该 action 是否仍存在。
 *
 * 语义说明（T6）：本方法天然需要「新鲜」的巡检结果，但它无权发起巡检
 * （触发权属体检/inspect 域）。因此正确用法是：用户修完后先重跑项目体检
 * 让快照刷新，再回来点验证。快照缺失或未刷新时**保守返回 false**——
 * 宁可显示「未还清」，绝不在没有证据时宣称「已还清」。
 */
async function verifyDebtRepaidHandler(projectPath: string, actionId: string): Promise<boolean> {
  try {
    if (
      !projectPath ||
      typeof projectPath !== 'string' ||
      !actionId ||
      typeof actionId !== 'string'
    )
      return false;
    const input = await loadDebtInputFromSnapshot(projectPath);
    if (!input.ok) {
      console.warn('[engine:debt:verifyRepaid] 无 inspect 域快照，保守判为未还清');
      return false;
    }
    const moduleHotness = await collectModuleHotness(projectPath);
    const exposedFiles = await collectExposedFilesInWorker(projectPath);
    const snapshot = buildTechDebtDashboard({
      projectId: input.projectId,
      issues: input.issues,
      moduleHotness,
      exposedFiles,
    });
    const stillPresent = snapshot.actionList.some((a) => a.actionId === actionId);
    if (stillPresent) return false;
    const db = getDb();
    updateDebtActionStatus(db, { projectId: snapshot.projectId, actionId, status: 'repaid' });
    return true;
  } catch (err) {
    console.warn(
      '[engine:debt:verifyRepaid] 验证失败:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

async function dismissDebtActionHandler(projectPath: string, actionId: string): Promise<void> {
  try {
    if (
      !projectPath ||
      typeof projectPath !== 'string' ||
      !actionId ||
      typeof actionId !== 'string'
    )
      return;
    const db = getDb();
    updateDebtActionStatus(db, { projectId: projectPath, actionId, status: 'dismissed' });
  } catch (err) {
    console.warn(
      '[engine:debt:dismiss] 忽略操作失败:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** 各项目已实例化的密钥生命周期管理器（key = projectPath，状态变更按 secretId 反查项目） */
const secretManagers = new Map<
  string,
  { manager: SecretLifecycleManager; store: FileSecretStore }
>();

/** 密钥扫描失败时的空报告（error 携带失败原因，不 throw） */
function emptySecretsReport(error: string): SecretReportData {
  return {
    findings: [],
    summary: { total: 0, critical: 0, active: 0, historyFound: 0 },
    lastScannedCommit: '',
    error,
  };
}

/**
 * 密钥全生命周期扫描（engine:runSecrets）：直连主进程，不注册 TaskManager 任务类型。
 * 状态落盘 .zhshield/secrets-state.json（FileSecretStore 自建目录），
 * 实例按 projectPath 缓存供 markRotating / verifyRotated / dismiss 反查。
 */
async function runSecretsHandler(projectPath: string): Promise<SecretReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const store = new FileSecretStore(path.join(projectPath, '.zhshield', 'secrets-state.json'));
    const manager = new SecretLifecycleManager(undefined, store);
    secretManagers.set(projectPath, { manager, store });
    const report = await manager.scan(projectPath, { history: true });
    // P1b: 补写 dashboard-state secrets 域（active 未处理数 + lastRunAt）
    await updateDashboardState(projectPath, {
      secrets: { activeCount: report.summary.active, lastRunAt: new Date().toISOString() },
    });
    return { ...report, error: null };
  } catch (err) {
    console.error('[engine:runSecrets] Error:', err);
    return emptySecretsReport(err instanceof Error ? err.message : String(err));
  }
}

/** 按 secretId 反查持有该密钥状态的项目管理器；未找到返回 undefined（对应渲染层静默成功/返回 false） */
async function findSecretManager(
  secretId: string,
): Promise<{ manager: SecretLifecycleManager } | undefined> {
  for (const { manager, store } of secretManagers.values()) {
    const state = await store.load();
    if (state.secrets[secretId]) return { manager };
  }
  return undefined;
}

/** 标记密钥进入轮换（engine:secretRotating）；未找到对应项目时静默成功 */
async function markSecretRotatingHandler(secretId: string): Promise<void> {
  try {
    if (!secretId || typeof secretId !== 'string') return;
    const entry = await findSecretManager(secretId);
    if (!entry) return;
    await entry.manager.markRotating(secretId);
  } catch (err) {
    console.error('[engine:secretRotating] Error:', err);
  }
}

/** 复核密钥是否已轮换（engine:secretVerify）；未找到对应项目时返回 false */
async function verifySecretRotatedHandler(secretId: string): Promise<boolean> {
  try {
    if (!secretId || typeof secretId !== 'string') return false;
    const entry = await findSecretManager(secretId);
    if (!entry) return false;
    return entry.manager.verifyRotated(secretId);
  } catch (err) {
    console.error('[engine:secretVerify] Error:', err);
    return false;
  }
}

/** 驳回密钥告警（engine:secretDismiss）；未找到对应项目时静默成功 */
async function dismissSecretHandler(secretId: string, reason: string): Promise<void> {
  try {
    if (!secretId || typeof secretId !== 'string') return;
    const entry = await findSecretManager(secretId);
    if (!entry) return;
    await entry.manager.dismiss(secretId, reason);
  } catch (err) {
    console.error('[engine:secretDismiss] Error:', err);
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

/**
 * 将 @zh/fingerprint profileProject 结果投影为画像缓存并触发 T0 云端注册。
 * onboarding 第 1 步（engine:runProfile）探测后立即调用，
 * 使第 2 步 syncRules 能读到画像做按需裁剪（否则退化为全量 4 工具同步）。
 */
export function cacheProfileFromFingerprintResult(result: unknown, projectPath: string): void {
  try {
    const { profile } = (result ?? {}) as { profile?: import('@zh/fingerprint').ProjectProfile };
    const target = profile?.targets?.[0];
    if (!target) {
      console.warn('[engine:runProfile] 画像无 targets，跳过缓存（同步保持全量）');
      return;
    }
    const feature: CachedProjectFeature = {
      language: target.language?.value,
      framework: target.frameworks?.[0]?.value,
      features: [],
    };
    setCachedProfile(feature, projectPath);
    void registerProjectFeaturesToCloud(feature, projectPath);
    console.log(
      `[engine:runProfile] 画像已缓存: language=${feature.language ?? 'unknown'} framework=${feature.framework ?? 'unknown'}`,
    );
  } catch (err) {
    console.warn(
      '[engine:runProfile] 画像缓存失败（不影响探测结果返回）:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function runProfileHandler(projectPath: string): Promise<unknown> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error(t('electron.invalidProjectPath'));
  }
  // 画像探测含全量同步扫盘（@zh/fingerprint detectors），必须离主进程，否则 macOS 彩球
  const result = await runProfileInWorker(projectPath);
  cacheProfileFromFingerprintResult(result, projectPath);
  return result;
}

async function getScoreHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectId: string,
): Promise<HealthScoreData | null> {
  try {
    const scoring = await getScoring();
    const score = scoring.getCurrent(projectId);
    return score ? toHealthScoreData(score) : null;
  } catch (err) {
    console.warn(
      '[engine:getScore] 评分读取失败:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function getScoreHistoryHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectId: string,
): Promise<HealthScoreData[]> {
  try {
    const scoring = await getScoring();
    return scoring.getHistory(projectId).map(toHealthScoreData);
  } catch (err) {
    console.warn(
      '[engine:getScoreHistory] 评分历史读取失败:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * 分类页实时评分：读该域最近一次检查落盘的按域快照自带评分。
 * 评分在落盘时由 @zh/scoring 统一计算（与报告中心汇总同一函数），此处只读不算；
 * 快照缺失或为旧格式（无 dimensionScore）时返回 null，由渲染层回退到报告中心汇总。
 */
async function getDomainScoreHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
): Promise<DomainScoreData | null> {
  try {
    const snap = await readDomainSnapshot(projectPath, 'inspect');
    if (!snap?.dimensionScore) return null;
    return {
      ...snap.dimensionScore,
      generatedAt: snap.generatedAt,
      previousScore: snap.previousScore,
    };
  } catch (err) {
    console.warn(
      '[engine:getDomainScore] 实时评分读取失败:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** 项目画像（含子模块列表）：供报告页列出模块用于模块级评分卡展示；探测失败时返回 null */
async function getProfileHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
): Promise<ProjectProfileData | null> {
  try {
    const profilingResult = (await runProfileSyncInWorker(projectPath)).profile;
    cacheProfile(profilingResult, projectPath);
    return {
      type: profilingResult.type,
      modules: (profilingResult.modules ?? []).map((m) => ({ path: m.path, type: m.type })),
    };
  } catch (err) {
    console.warn(
      '[engine:getProfile] 画像探测失败:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
