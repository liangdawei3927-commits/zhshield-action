/**
 * 治理引擎 IPC（ipc/engines.ts）
 *
 * Guard / Inspect / Security / Refactor / Pipeline / Scoring 全部走子进程执行，
 * 主进程仅转发与转换报告；体检发现问题后自动触发 opencode CLI 修复（非阻塞）。
 */

import { ipcMain, app } from 'electron';
import path from 'node:path';
import { constants as FS_CONSTANTS } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { t } from '@zh/i18n';

import {
  buildHealthDimensions,
  buildTechDebtDashboard,
  mergeActionStatuses,
  computeTrendDelta,
  scoreProjectByModules,
} from '@zh/scoring';
import type {
  DebtIssueInput,
  ModuleHotnessInput,
  ConvertedGuardResult,
  ConvertedInspectIssue,
  HealthScore,
} from '@zh/scoring';
import type { CheckOptions, GuardReport } from '@zh/guard';
import { appendGuardReport, toGuardReportRecord } from '@zh/guard';
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
  normalizeInspectSource,
  normalizeRefactorSource,
  normalizePerformanceData,
  normalizeDepsSource,
  normalizeTechDebtSource,
  normalizeSecuritySource,
} from '../zh-diagnostics';
import {
  readDashboardState,
  updateDashboardState,
  type DashboardDepsState,
  type DashboardTechDebtState,
  type DashboardRefactorState,
  type DashboardPerformanceState,
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
  getSentinel,
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
  toInspectionReportData,
  toSecurityScanReportData,
  toHealthScoreData,
  type GuardReportData,
  type InspectionReportData,
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
  DashboardOverview,
  DashboardCard,
} from '../../src/types/electron';
import type { DiagnosticsReport, DiagnosticEntry } from '../zh-diagnostics';

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
 * 体检完成后将 guard + inspect 报告转化为健康维度分并落库。
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
    const score = scoring.calculate(projectPath, dimensions);
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

export function registerEnginesIpc(manager: TaskManager): void {
  ipcMain.handle('engine:runGuard', (_e, projectPath: string, options?: Partial<CheckOptions>) =>
    runGuardHandler(manager, projectPath, options),
  );
  ipcMain.handle('engine:runInspect', (_e, projectPath: string) =>
    runInspectHandler(manager, projectPath),
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
    runTechDebtHandler(manager, projectPath),
  );
  ipcMain.handle(
    'debt:planRepayment',
    (
      _e,
      projectPath: string,
      actionId: string,
      opts?: { sprint?: string; gate?: 'allow-with-record' },
    ) => planDebtRepaymentHandler(manager, projectPath, actionId, opts),
  );
  ipcMain.handle('debt:verifyRepaid', (_e, projectPath: string, actionId: string) =>
    verifyDebtRepaidHandler(manager, projectPath, actionId),
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
  ipcMain.handle('engine:getProfile', getProfileHandler);
  ipcMain.handle('engine:runProfile', (_e, projectPath: string) => runProfileHandler(projectPath));
  // P1b 聚合仪表盘：只读各域最新落盘结果 + 时间戳，一次返回六卡数据
  ipcMain.handle('engine:getDashboardOverview', getDashboardOverviewHandler);
  ipcMain.handle('engine:runFullCheck', (_e, projectPath: string, options?: { force?: boolean }) =>
    runFullCheckHandler(manager, projectPath, options),
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
      await persistDiagnosticsFromEntries(projectPath, normalizeGuardSource(report));
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

/** 运行 inspect 巡检并返回原生报告（runInspect / runTechDebt 共用同一执行路径） */
async function runInspectTask(
  manager: TaskManager,
  projectPath: string,
): Promise<InspectionReport> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error(t('electron.invalidProjectPath'));
  }
  const task = manager.start('inspect', projectPath);
  return (await manager.waitFor(task.id)) as InspectionReport;
}

async function runInspectHandler(
  manager: TaskManager,
  projectPath: string,
): Promise<InspectionReportData> {
  try {
    const report = await runInspectTask(manager, projectPath);
    try {
      await persistDiagnosticsFromEntries(projectPath, normalizeInspectSource(report));
    } catch (e) {
      console.warn('[engine:runInspect] 诊断落盘失败:', e instanceof Error ? e.message : String(e));
    }
    return toInspectionReportData(report);
  } catch (err) {
    console.error('[engine:runInspect] Error:', err);
    return {
      summary: { total: 0, passed: 0, warnings: 0, failures: 0 },
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
      await persistDiagnosticsFromEntries(projectPath, normalizeSecuritySource(data));
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
    return (await manager.waitFor(task.id)) as GarbageScanReport;
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
      await persistDiagnosticsFromEntries(projectPath, normalizePerformanceData(result));
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
      await persistDiagnosticsFromEntries(projectPath, normalizeRefactorSource(report));
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

// ─── 仪表盘聚合（P1b）─────────────────────────────────────────────

/** 新鲜度阈值：lastRunAt 距今 >24h 视为过期（方案 §3.3 ②） */
const DASHBOARD_FRESH_MS = 24 * 60 * 60 * 1000;

/** 哨兵已解决状态：不在集合内的事件视为 open（未处理） */
const RESOLVED_SENTINEL_STATUSES: ReadonlySet<string> = new Set([
  'passed',
  'merged',
  'deployed',
  'rolled_back',
]);

/** 六卡 → 评分维度权重（方案 §4.3：质量35% / 安全25% / 依赖15% / 技术债15% / 门禁哨兵10%） */
const DASHBOARD_CARD_WEIGHTS: Record<DashboardCard['key'], number> = {
  quality: 0.35,
  security: 0.25,
  dependencies: 0.15,
  techdebt: 0.15,
  gate: 0.05,
  sentinel: 0.05,
};

/**
 * P1b extras 契约（对齐 Agent A 迁移后的 DimensionExtras）：
 * secrets/deps/techdebt/refactor/performance 域最新数据，无对应域时传 null（Agent A 侧按 null 跳过该维度）。
 */
interface PipelineExtras {
  secrets?: { activeCount: number } | null;
  deps?: {
    vulnerabilities: { critical: number; high: number; medium: number };
    upgradable: number;
  } | null;
  techdebt?: { debtIndex: number; issueCount: number } | null;
  refactor?: {
    totalSmells: number;
    bySeverity: { error: number; warning: number; info: number };
  } | null;
  performance?: {
    total: number;
    bySeverity: { critical: number; high: number; medium: number; low: number; info: number };
  } | null;
}

/** 从 dashboard-state.json 组装 extras（无对应域时传 null） */
async function buildPipelineExtras(projectPath: string): Promise<PipelineExtras> {
  const state = await readDashboardState(projectPath);
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
      await persistDiagnosticsFromEntries(projectPath, normalizeDepsSource(report));
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
 * 技术债仪表盘（engine:runTechDebt）：直连主进程，不注册 TaskManager 任务类型。
 * 复用 inspect 巡检产出 issues，叠加 git 模块热度 + 对外接口清单，
 * 由 @zh/scoring buildTechDebtDashboard 生成 ROI 排序报告。
 * 对外接口清单的同步扫盘已移入 profile worker（collectExposedFilesInWorker）。
 */
async function runTechDebtHandler(
  manager: TaskManager,
  projectPath: string,
): Promise<TechDebtReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const inspectReport = await runInspectTask(manager, projectPath);
    const issues: DebtIssueInput[] = inspectReport.issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      category: issue.category,
      file: issue.file,
    }));
    const moduleHotness = await collectModuleHotness(projectPath);
    const exposedFiles = await collectExposedFilesInWorker(projectPath);
    const snapshot = buildTechDebtDashboard({
      projectId: inspectReport.projectId,
      issues,
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
      await persistDiagnosticsFromEntries(projectPath, normalizeTechDebtSource(report));
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
  manager: TaskManager,
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
    const inspectReport = await runInspectTask(manager, projectPath);
    const issues: DebtIssueInput[] = inspectReport.issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      category: issue.category,
      file: issue.file,
    }));
    const moduleHotness = await collectModuleHotness(projectPath);
    const exposedFiles = await collectExposedFilesInWorker(projectPath);
    const snapshot = buildTechDebtDashboard({
      projectId: inspectReport.projectId,
      issues,
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

async function verifyDebtRepaidHandler(
  manager: TaskManager,
  projectPath: string,
  actionId: string,
): Promise<boolean> {
  try {
    if (
      !projectPath ||
      typeof projectPath !== 'string' ||
      !actionId ||
      typeof actionId !== 'string'
    )
      return false;
    const inspectReport = await runInspectTask(manager, projectPath);
    const issues: DebtIssueInput[] = inspectReport.issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      category: issue.category,
      file: issue.file,
    }));
    const moduleHotness = await collectModuleHotness(projectPath);
    const exposedFiles = await collectExposedFilesInWorker(projectPath);
    const snapshot = buildTechDebtDashboard({
      projectId: inspectReport.projectId,
      issues,
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

// ─── P1b 聚合仪表盘（engine:getDashboardOverview / engine:runFullCheck）────────

/** 新鲜度判定：lastRunAt 缺失或距今 >24h → expired（方案 §3.3 ②） */
function freshnessStatus(lastRunAt: string | null | undefined, now: number): 'scored' | 'expired' {
  if (!lastRunAt) return 'expired';
  const t = new Date(lastRunAt).getTime();
  if (Number.isNaN(t)) return 'expired';
  return now - t > DASHBOARD_FRESH_MS ? 'expired' : 'scored';
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

/** 从 scoring 维度数组取指定维度分；缺失返回 undefined */
function dimensionScoreFrom(score: HealthScoreData | null, name: string): number | undefined {
  return score?.dimensions.find((d) => d.name === name)?.score;
}

/** quality 卡：latest.json 中 source='inspect' + source='refactor' 的 issues（含 quality/refactor/performance 三维聚合） */
function buildQualityCard(
  issues: readonly DiagnosticEntry[],
  lastRunAt: string | null,
  score: HealthScoreData | null,
  now: number,
): DashboardCard {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const card: DashboardCard = {
    key: 'quality',
    // 状态以 lastRunAt 为准：0 检出 ≠ 未运行（干净通过也必须显示 scored，否则跑完仍显示"未检测"）
    status: lastRunAt ? freshnessStatus(lastRunAt, now) : 'not-run',
    issues: issues.length,
    ...(lastRunAt ? { lastRunAt } : {}),
    summary: `${errors} error / ${warnings} warning`,
  };
  // 三维聚合：quality/refactor/performance 按各自权重加权，仅对已出现的维度归一化
  const dimKeys = ['quality', 'refactor', 'performance'] as const;
  const dimWeights: Record<string, number> = { quality: 0.2, refactor: 0.1, performance: 0.05 };
  const present = dimKeys.filter((k) => dimensionScoreFrom(score, k) !== undefined);
  if (present.length > 0) {
    const wsum = present.reduce((s, k) => s + dimWeights[k], 0);
    card.score = clampScore(
      present.reduce((s, k) => s + dimensionScoreFrom(score, k)! * dimWeights[k], 0) / wsum,
    );
  }
  // 回退口径：无 scoring 数据时按扣分制计算（0 issues → 100），运行过就该计入加权总分
  else card.score = clampScore(100 - errors * 8 - warnings * 4);
  return card;
}

/** gate 卡：latest.json 中 source='guard' 的 issues（guard 计入 security 维度） */
function buildGateCard(
  issues: readonly DiagnosticEntry[],
  lastRunAt: string | null,
  score: HealthScoreData | null,
  now: number,
): DashboardCard {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const card: DashboardCard = {
    key: 'gate',
    // 状态以 lastRunAt 为准：guard 全过（0 issues）≠ 未运行
    status: lastRunAt ? freshnessStatus(lastRunAt, now) : 'not-run',
    issues: issues.length,
    ...(lastRunAt ? { lastRunAt } : {}),
    summary: `${errors} error / ${warnings} warning`,
  };
  const dim = dimensionScoreFrom(score, 'gate');
  if (dim !== undefined) card.score = dim;
  // 回退口径：同 quality 卡，guard 全过（0 issues）= 100 分且计入加权总分
  else card.score = clampScore(100 - errors * 8 - warnings * 4);
  return card;
}

/** security 卡：secrets-state.json 中 status='active' 的密钥数（active 未处理数） */
function buildSecurityCard(
  activeCount: number,
  stateExists: boolean,
  lastRunAt: string | null | undefined,
  score: HealthScoreData | null,
  now: number,
): DashboardCard {
  const card: DashboardCard = {
    key: 'security',
    status: stateExists ? freshnessStatus(lastRunAt, now) : 'not-run',
    issues: activeCount,
    ...(lastRunAt ? { lastRunAt } : {}),
    summary: `${activeCount} active secrets`,
  };
  const dim = dimensionScoreFrom(score, 'security');
  if (dim !== undefined) card.score = dim;
  else if (stateExists) card.score = clampScore(100 - activeCount * 15); // 方案 §4.3.1：active 每条 -15（上限 60）
  return card;
}

/** deps 卡：dashboard-state.json.deps（漏洞 severity 计数 + 可升级数） */
function buildDepsCard(
  deps: DashboardDepsState | undefined,
  score: HealthScoreData | null,
  now: number,
): DashboardCard {
  if (!deps) {
    return { key: 'dependencies', status: 'not-run', issues: 0, summary: 'not run' };
  }
  const { critical, high, medium } = deps.vulnerabilities;
  const total = critical + high + medium;
  const card: DashboardCard = {
    key: 'dependencies',
    status: freshnessStatus(deps.lastRunAt, now),
    issues: total,
    lastRunAt: deps.lastRunAt,
    summary: `${critical} critical / ${high} high / ${medium} medium, ${deps.upgradable} upgradable`,
  };
  const dim = dimensionScoreFrom(score, 'dependencies');
  if (dim !== undefined) card.score = dim;
  else if (total > 0) card.score = clampScore(100 - critical * 12 - high * 8 - medium * 4); // 方案 §4.3.1
  return card;
}

/** techdebt 卡：dashboard-state.json.techdebt（debtIndex + 动作数） */
function buildTechDebtCard(
  techdebt: DashboardTechDebtState | undefined,
  score: HealthScoreData | null,
  now: number,
): DashboardCard {
  if (!techdebt) {
    return { key: 'techdebt', status: 'not-run', issues: 0, summary: 'not run' };
  }
  const card: DashboardCard = {
    key: 'techdebt',
    status: freshnessStatus(techdebt.lastRunAt, now),
    issues: techdebt.issueCount,
    lastRunAt: techdebt.lastRunAt,
    summary: `debtIndex ${techdebt.debtIndex}`,
  };
  const dim = dimensionScoreFrom(score, 'techdebt');
  if (dim !== undefined) card.score = dim;
  else card.score = clampScore(100 - techdebt.debtIndex); // 方案 §4.3.1：techdebt 健康分 = 100 − debtIndex
  return card;
}

/** sentinel 卡：运行时 SentinelRuntime（P1a-3 豁免，不落盘）——enabled + open 事件计数 */
function buildSentinelCard(
  enabled: boolean,
  openCount: number,
  lastEventAt: string | null,
  now: number,
): DashboardCard {
  const card: DashboardCard = {
    key: 'sentinel',
    status: enabled ? freshnessStatus(lastEventAt, now) : 'not-run',
    issues: openCount,
    ...(lastEventAt ? { lastRunAt: lastEventAt } : {}),
    summary: enabled ? `${openCount} open events` : 'disabled',
  };
  // 哨兵为运行时域（P1a-3 豁免不落盘），不计入持久化维度；分值直接由开放事件推导
  if (enabled && openCount > 0) card.score = clampScore(100 - openCount * 5);
  return card;
}

/** 未运行域剔除后的加权总分（方案 §4.3：某域从未运行时该域不参与加权，禁止按满分计） */
function computeFallbackOverall(cards: readonly DashboardCard[]): number {
  let weightedSum = 0;
  let weightSum = 0;
  for (const card of cards) {
    if (card.status === 'not-run' || card.score === undefined) continue;
    const weight = DASHBOARD_CARD_WEIGHTS[card.key];
    weightedSum += card.score * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? Math.round((weightedSum / weightSum) * 100) / 100 : 0;
}

function gradeFromScore(overall: number): string {
  if (overall >= 90) return 'A';
  if (overall >= 75) return 'B';
  if (overall >= 60) return 'C';
  return 'D';
}

/**
 * 聚合仪表盘（engine:getDashboardOverview）：纯只读，一次返回六卡数据。
 * 不触发任何扫描（聚合层是纯只读，禁止调 runPipeline）。
 */
async function getDashboardOverviewHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
): Promise<DashboardOverview | null> {
  try {
    if (!projectPath || typeof projectPath !== 'string') return null;
    const now = Date.now();

    // ── latest.json（quality / gate 卡）──
    let latest: DiagnosticsReport | null = null;
    try {
      const raw = await readFile(
        path.join(projectPath, '.zhshield', 'diagnostics', 'latest.json'),
        'utf-8',
      );
      latest = JSON.parse(raw) as DiagnosticsReport;
    } catch {
      latest = null;
    }
    const latestGeneratedAt = latest?.generatedAt ?? null;
    const latestIssues = latest?.issues ?? [];
    const inspectIssues = latestIssues.filter((i) => i.source === 'inspect');
    const guardIssues = latestIssues.filter((i) => i.source === 'guard');
    const refactorIssues = latestIssues.filter((i) => i.source === 'refactor');
    // quality 卡合并 inspect + refactor 问题（performance 经 source='inspect' 已含在 inspectIssues）
    const mergedQualityIssues = [...inspectIssues, ...refactorIssues];

    // ── secrets-state.json（security 卡：active 未处理数）──
    let secretsActive = 0;
    let secretsStateExists = false;
    try {
      const raw = await readFile(
        path.join(projectPath, '.zhshield', 'secrets-state.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw) as { secrets?: Record<string, { status?: string }> };
      secretsStateExists = true;
      secretsActive = Object.values(parsed.secrets ?? {}).filter(
        (s) => s.status === 'active',
      ).length;
    } catch {
      secretsStateExists = false;
    }

    // ── dashboard-state.json（deps / techdebt 卡）──
    const dashState = await readDashboardState(projectPath);

    // ── sentinel 运行时（sentinel 卡：enabled + open 事件计数，P1a-3 豁免不落盘）──
    let sentinelEnabled = false;
    let sentinelOpen = 0;
    let sentinelLastEventAt: string | null = null;
    try {
      const { eventCenter } = await getSentinel();
      const events = eventCenter.listEvents();
      sentinelOpen = events.filter((e) => !RESOLVED_SENTINEL_STATUSES.has(e.status)).length;
      const lastEvent = events.at(-1);
      sentinelLastEventAt = lastEvent
        ? lastEvent.timestamp instanceof Date
          ? lastEvent.timestamp.toISOString()
          : String(lastEvent.timestamp)
        : null;
      try {
        const raw = await readFile(
          path.join(app.getPath('userData'), 'sentinel-state.json'),
          'utf-8',
        );
        const parsed = JSON.parse(raw) as { enabled?: boolean };
        sentinelEnabled = parsed.enabled ?? true;
      } catch {
        sentinelEnabled = true;
      }
    } catch {
      sentinelEnabled = false;
    }

    // ── scoring（总评分优先取库内最新）──
    let score: HealthScoreData | null = null;
    let currentScore: HealthScore | null = null;
    try {
      const scoring = await getScoring();
      const current = scoring.getCurrent(projectPath);
      if (current) {
        currentScore = current;
        score = toHealthScoreData(current);
      }
    } catch {
      score = null;
    }

    const cards: DashboardCard[] = [
      buildQualityCard(mergedQualityIssues, latestGeneratedAt, score, now),
      buildGateCard(guardIssues, latestGeneratedAt, score, now),
      buildSecurityCard(
        secretsActive,
        secretsStateExists,
        dashState.secrets?.lastRunAt,
        score,
        now,
      ),
      buildDepsCard(dashState.deps, score, now),
      buildTechDebtCard(dashState.techdebt, score, now),
      buildSentinelCard(sentinelEnabled, sentinelOpen, sentinelLastEventAt, now),
    ];

    const overall = score ? score.score : computeFallbackOverall(cards);
    const grade = currentScore ? currentScore.grade : gradeFromScore(overall);
    const trend = currentScore ? currentScore.trend : 'stable';

    return {
      projectPath,
      overall,
      grade,
      trend,
      cards,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(
      '[engine:getDashboardOverview] 聚合读取失败:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * 单域执行超时阈值（§六 风险②"单域超时独立熔断不拖垮整体"）。
 * 取值依据：semgrep 冷启动 80-150s + 1200+ 文件 monorepo 巡检 151s（§4.3.2 实测），
 * 单域最坏约 5 分钟；10 分钟为 2 倍余量的硬熔断线，防止任一域永久挂起拖垮整体。
 */
const DOMAIN_TIMEOUT_MS = 10 * 60 * 1000;

/** 给 Promise 加超时熔断：超时后 reject 并释放定时器（底层任务若仍运行则交 cancel 兜底） */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`域 ${label} 执行超时（>${ms}ms），已熔断跳过`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 撤销某域在 TaskManager 中正在排队的任务（§六 风险② 熔断后的兜底清理）。
 * 仅对走 TaskManager 的任务生效：deps/secrets 为纯函数直跑（无 TaskManager 任务），跳过。
 */
function cancelDomainTask(manager: TaskManager, domainKey: string, projectPath: string): void {
  const kindByDomain: Record<string, string> = {
    guard: 'guard',
    inspect: 'inspect',
    security: 'security',
    techdebt: 'inspect',
    refactor: 'refactor',
    performance: 'performance',
  };
  const kind = kindByDomain[domainKey];
  if (!kind) return;
  for (const task of manager.list()) {
    if (
      task.kind === kind &&
      task.projectPath === projectPath &&
      (task.status === 'queued' || task.status === 'running')
    ) {
      manager.cancel(task.id);
    }
  }
}

/**
 * 一键全检（engine:runFullCheck）：默认读 dashboard-state.json，仅重跑 lastRunAt 距今 >24h 的域；
 * force:true 时全量 8 域。严格按序执行（并发=1，8GB 机器红线，方案 §3.3 ③ / §六）。
 * guard/inspect/security 未在 dashboard-state.json 中跟踪 lastRunAt → 默认模式下始终重跑。
 * 返回语义：ok=true 表示全检流程完整执行（所有域均完成或已做新鲜度判断），
 * 没有任何域重跑（reran 空）也属于成功（数据已新鲜）；单域失败进 failed，不判整体失败。
 */
async function runFullCheckHandler(
  manager: TaskManager,
  projectPath: string,
  options?: { force?: boolean },
): Promise<{ ok: boolean; reran: string[]; skipped: string[]; failed?: string[]; error?: string }> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const force = options?.force === true;
    const dashState = await readDashboardState(projectPath);
    const now = Date.now();
    const isStale = (lastRunAt?: string): boolean =>
      !lastRunAt || now - new Date(lastRunAt).getTime() > DASHBOARD_FRESH_MS;

    const domains: Array<{ key: string; stale: boolean; run: () => Promise<void> }> = [
      {
        key: 'guard',
        stale: true,
        run: async () => void (await runGuardHandler(manager, projectPath)),
      },
      {
        key: 'inspect',
        stale: true,
        run: async () => void (await runInspectHandler(manager, projectPath)),
      },
      {
        key: 'security',
        stale: true,
        run: async () => void (await runSecurityHandler(manager, projectPath)),
      },
      {
        key: 'deps',
        stale: isStale(dashState.deps?.lastRunAt),
        run: async () => void (await runDepsHandler(projectPath)),
      },
      {
        key: 'techdebt',
        stale: isStale(dashState.techdebt?.lastRunAt),
        run: async () => void (await runTechDebtHandler(manager, projectPath)),
      },
      {
        key: 'secrets',
        stale: isStale(dashState.secrets?.lastRunAt),
        run: async () => void (await runSecretsHandler(projectPath)),
      },
      {
        key: 'refactor',
        stale: isStale(dashState.refactor?.lastRunAt),
        run: async () => void (await runRefactorHandler(manager, projectPath)),
      },
      {
        key: 'performance',
        stale: isStale(dashState.performance?.lastRunAt),
        run: async () => void (await runPerformanceHandler(manager, projectPath)),
      },
    ];

    const reran: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const domain of domains) {
      if (!force && !domain.stale) {
        skipped.push(domain.key);
        continue;
      }
      try {
        await withTimeout(domain.run(), DOMAIN_TIMEOUT_MS, domain.key);
        reran.push(domain.key);
      } catch (err) {
        console.warn(
          `[engine:runFullCheck] ${domain.key} 执行失败:`,
          err instanceof Error ? err.message : String(err),
        );
        cancelDomainTask(manager, domain.key, projectPath);
        failed.push(domain.key);
      }
    }
    // ok=true：全检流程已完成（无论是否有域重跑/失败）；单域失败单独上报 failed
    return { ok: true, reran, skipped, failed };
  } catch (err) {
    console.error('[engine:runFullCheck] Error:', err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      reran: [],
      skipped: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
