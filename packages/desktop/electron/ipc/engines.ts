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

import { buildHealthDimensions, buildTechDebtDashboard, mergeActionStatuses, computeTrendDelta, scoreProjectByModules } from '@zh/scoring';
import type { DebtIssueInput, ModuleHotnessInput } from '@zh/scoring';
import type { CheckOptions, GuardReport } from '@zh/guard';
import { appendGuardReport, toGuardReportRecord } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { SecurityScanReport, GarbageCleanResult, GarbageRestoreResult } from '@zh/security';
import { SecretLifecycleManager, FileSecretStore } from '@zh/security';
import type { RefactorReport } from '@zh/refactor';
import { createReport, type PipelineReport, type ProjectProfile } from '@zh/pipeline';
import { profileSync } from '@zh/fingerprint';
import { convertGuardEvaluations, convertInspectEvaluations, convertTraditionalGuardResults } from './score-converters';
import {
  buildDependencyGraph,
  buildLicenseMatrix,
  lockfileVerifier,
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
import { saveDebtAction, updateDebtActionStatus, getDebtActionsByProject, saveDebtSnapshot, getLatestDebtSnapshot } from '@zh/db';

import {
  persistDiagnostics,
  persistDiagnosticsFromEntries,
  normalizeGuardSource,
  normalizeInspectSource,
  normalizeRefactorSource,
  normalizePerformanceData,
} from '../zh-diagnostics';
import { shouldAutoFix, countFixableIssues, buildFixPrompt, resolveOpenCodeBin, resolveOpenCodeModel } from '../ai-auto-fix';
import { getScoring, getDb, sendProgress } from '../ipc-context';
import { collectExposedFilesInWorker, detectProfileInWorker, runProfileInWorker } from '../profile-host';
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
import type { DependencyReportData, TechDebtReportData, SecretReportData, ProjectProfileData } from '../../src/types/electron';

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
    candidates.push({ path: p, executable: await isExecutable(p) });
  }
  const homeLocalBin = path.join(os.homedir(), '.local', 'bin', 'opencode');
  if (!candidates.some((c) => c.path === homeLocalBin)) {
    candidates.push({ path: homeLocalBin, executable: await isExecutable(homeLocalBin) });
  }
  return candidates;
}

/** 以 detached 方式启动 opencode 修复进程，仅记录日志与进度，不阻塞主进程 */
function spawnOpenCodeFix(bin: string, projectPath: string, fixableError: number, fixableWarning: number): void {
  const model = resolveOpenCodeModel(process.env.ZH_OPENCODE_MODEL);
  const child = spawn(bin, ['run', '-m', model, '--dir', projectPath, buildFixPrompt(projectPath)], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => console.warn('[ai:autofix] 启动 opencode 失败:', err.message));
  child.on('exit', (code) => console.log(`[ai:autofix] opencode 修复进程退出，code=${code ?? 'null'}`));
  child.unref();
  sendProgress('autofix', t('pipeline.autofix.started', { errors: fixableError, warnings: fixableWarning }), 1);
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

/**
 * 体检完成后将 guard + inspect 报告转化为健康维度分并落库。
 * 支持两种报告格式：
 * 1. 传统格式：GuardReport（有 results）+ InspectionReport（有 issues）
 * 2. SOP 格式：RuleEngineReport（有 evaluations）— 需要转换
 */
async function recordPipelineScore(projectPath: string, report: PipelineReport): Promise<void> {
  try {
    const guardReport = report.guard;
    const inspectReport = report.inspect;
    if (!guardReport || !inspectReport) {
      console.warn('[engine:runPipeline] 跳过评分: 缺少 guard 或 inspect 报告', { hasGuard: !!guardReport, hasInspect: !!inspectReport });
      return;
    }
    const isSop = isRuleEngineReport(guardReport) && isRuleEngineReport(inspectReport);

    let guardResults: Array<{ severity: 'error' | 'warning' | 'info'; status: 'passed' | 'failed' | 'error' | 'warning'; blocking: boolean; file?: string }>;
    let inspectIssues: Array<{ severity: 'error' | 'warning' | 'info'; category: string; file?: string }>;

    if (isSop) {
      // SOP 模式：从 evaluations 转换
      guardResults = convertGuardEvaluations(guardReport.evaluations);
      inspectIssues = convertInspectEvaluations(inspectReport.evaluations);
    } else if (isRuleEngineReport(guardReport) || isRuleEngineReport(inspectReport)) {
      // 混合格式：跳过评分（不应该发生）
      console.warn('[engine:runPipeline] 跳过评分: 混合报告格式（guard/inspect 不同类型）');
      return;
    } else {
      // 传统模式
      guardResults = (guardReport as GuardReport).results;
      inspectIssues = (inspectReport as InspectionReport).issues;
    }

    const scoring = await getScoring();
    // 画像驱动评分：探测项目画像（语言/框架/类型），失败时降级为默认配置
    let profilingResult = null;
    try {
      profilingResult = profileSync(projectPath).profile;
    } catch (err) {
      console.warn('[engine:runPipeline] 画像探测失败，降级默认评分配置:', err instanceof Error ? err.message : String(err));
    }
    const dimensions = buildHealthDimensions(
      { results: guardResults },
      { issues: inspectIssues },
      projectPath,        // 修复：传 projectPath 让项目级 .zhshield/scoring.yml 生效
      profilingResult,    // 画像驱动：按项目类型自动微调维度权重
    );
    const score = scoring.calculate(projectPath, dimensions);
    console.log(`[engine:runPipeline] 健康评分已落库: ${score.overall} (${score.grade})`);

    // 模块级独立评分（monorepo）：画像含子模块时，按模块目录分桶、各模块用自身类型权重评分后逐模块落库。
    // 跳过根级兜底卡（path === projectPath），其 findings 已计入上方项目整体分，避免覆盖。
    if (profilingResult?.modules?.length) {
      // 模块级分桶：传统模式把聚合 CheckResult 按文件路径拆成逐文件结果，使其正确归属子模块；
      // SOP 模式 evaluate 已带 file，直接复用。项目整体分（上方 buildHealthDimensions）仍用聚合结果，行为不变。
      const moduleGuardResults = isSop
        ? guardResults
        : convertTraditionalGuardResults((guardReport as GuardReport).results);
      const aggregate = scoreProjectByModules(
        profilingResult,
        { results: moduleGuardResults },
        { issues: inspectIssues },
      );
      for (const card of aggregate.modules) {
        if (card.path === projectPath) continue;
        const moduleScore = scoring.calculate(card.path, card.dimensions);
        console.log(`[engine:runPipeline] 模块评分已落库: ${card.path} ${moduleScore.overall} (${moduleScore.grade})`);
      }
    }
  } catch (err) {
    console.warn('[engine:runPipeline] 健康评分落库失败:', err instanceof Error ? err.message : String(err));
  }
}

export function registerEnginesIpc(manager: TaskManager): void {
  ipcMain.handle('engine:runGuard', (_e, projectPath: string, options?: Partial<CheckOptions>) => runGuardHandler(manager, projectPath, options));
  ipcMain.handle('engine:runInspect', (_e, projectPath: string) => runInspectHandler(manager, projectPath));
  ipcMain.handle('engine:runSecurity', (_e, projectPath: string) => runSecurityHandler(manager, projectPath));
  ipcMain.handle('engine:garbageClean', (_e, projectPath: string, items: Array<{ id: string; path: string; size: number; type: string }>) => garbageCleanHandler(manager, projectPath, items));
  ipcMain.handle('engine:garbageRestore', (_e, projectPath: string, batchId: string) => garbageRestoreHandler(manager, projectPath, batchId));
  ipcMain.handle('engine:runPerformance', (_e, projectPath: string) => runPerformanceHandler(manager, projectPath));
  ipcMain.handle('engine:runRefactor', (_e, projectPath: string) => runRefactorHandler(manager, projectPath));
  ipcMain.handle('engine:runDeps', (_e, projectPath: string) => runDepsHandler(projectPath));
  ipcMain.handle('engine:runTechDebt', (_e, projectPath: string) => runTechDebtHandler(manager, projectPath));
  ipcMain.handle('debt:planRepayment', (_e, projectPath: string, actionId: string, opts?: { sprint?: string; gate?: 'allow-with-record' }) => planDebtRepaymentHandler(manager, projectPath, actionId, opts));
  ipcMain.handle('debt:verifyRepaid', (_e, projectPath: string, actionId: string) => verifyDebtRepaidHandler(manager, projectPath, actionId));
  ipcMain.handle('debt:dismiss', (_e, projectPath: string, actionId: string) => dismissDebtActionHandler(projectPath, actionId));
  ipcMain.handle('engine:runSecrets', (_e, projectPath: string) => runSecretsHandler(projectPath));
  ipcMain.handle('engine:secretRotating', (_e, secretId: string) => markSecretRotatingHandler(secretId));
  ipcMain.handle('engine:secretVerify', (_e, secretId: string) => verifySecretRotatedHandler(secretId));
  ipcMain.handle('engine:secretDismiss', (_e, secretId: string, reason: string) => dismissSecretHandler(secretId, reason));
  ipcMain.handle('engine:runPipeline', (_e, projectPath: string, options?: { dryRun?: boolean; sop?: boolean }) => runPipelineHandler(manager, projectPath, options));
  ipcMain.handle('engine:getScore', getScoreHandler);
  ipcMain.handle('engine:getScoreHistory', getScoreHistoryHandler);
  ipcMain.handle('engine:getProfile', getProfileHandler);
  ipcMain.handle('engine:runProfile', (_e, projectPath: string) => runProfileHandler(projectPath));
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
    const report = await manager.waitFor(task.id) as GuardReport;
    try {
      persistDiagnosticsFromEntries(projectPath, normalizeGuardSource(report));
    } catch (e) {
      console.warn('[engine:runGuard] 诊断落盘失败:', e instanceof Error ? e.message : String(e));
    }
    try {
      appendGuardReport(projectPath, toGuardReportRecord(report, options?.triggerSource ?? 'manual'));
    } catch (e) {
      console.warn('[engine:runGuard] 报告落库失败:', e instanceof Error ? e.message : String(e));
    }
    return toGuardReportData(report);
  } catch (err) {
    console.error('[engine:runGuard] Error:', err);
    return { summary: { totalChecks: 0, passed: 0, blocked: 0, warnings: 0 }, checks: [], metadata: { duration: 0, timestamp: new Date().toISOString() } };
  }
}

/** 运行 inspect 巡检并返回原生报告（runInspect / runTechDebt 共用同一执行路径） */
async function runInspectTask(manager: TaskManager, projectPath: string): Promise<InspectionReport> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error(t('electron.invalidProjectPath'));
  }
  const task = manager.start('inspect', projectPath);
  return await manager.waitFor(task.id) as InspectionReport;
}

async function runInspectHandler(manager: TaskManager, projectPath: string): Promise<InspectionReportData> {
  try {
    const report = await runInspectTask(manager, projectPath);
    try {
      persistDiagnosticsFromEntries(projectPath, normalizeInspectSource(report));
    } catch (e) {
      console.warn('[engine:runInspect] 诊断落盘失败:', e instanceof Error ? e.message : String(e));
    }
    return toInspectionReportData(report);
  } catch (err) {
    console.error('[engine:runInspect] Error:', err);
    return { summary: { total: 0, passed: 0, warnings: 0, failures: 0 }, checks: [], metadata: { duration: 0, timestamp: new Date().toISOString() } };
  }
}

async function runSecurityHandler(manager: TaskManager, projectPath: string): Promise<SecurityScanReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const task = manager.start('security', projectPath);
    const report = await manager.waitFor(task.id) as SecurityScanReport;
    return toSecurityScanReportData(report);
  } catch (err) {
    console.error('[engine:runSecurity] Error:', err);
    return {
      summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, malwareTotal: 0, garbageTotal: 0, garbageSize: 0 },
      findings: [],
      malware: [],
      garbage: [],
      securityScore: 100,
      metadata: { duration: 0, timestamp: new Date().toISOString() },
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
    const result = await manager.waitFor(task.id) as GarbageCleanResult;
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
    if (!projectPath || typeof projectPath !== 'string' || !batchId || typeof batchId !== 'string') {
      throw new Error(t('electron.invalidParams'));
    }
    const task = manager.start('garbageRestore', projectPath, { batchId });
    const result = await manager.waitFor(task.id) as GarbageRestoreResult;
    return result;
  } catch (err) {
    console.error('[engine:garbageRestore] Error:', err);
    return { restored: 0, restoredBytes: 0, failed: [t('electron.restoreFailed')] };
  }
}

async function runPerformanceHandler(manager: TaskManager, projectPath: string): Promise<PerformanceReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const task = manager.start('performance', projectPath);
    const result = await manager.waitFor(task.id) as PerformanceReportData;
    try {
      persistDiagnosticsFromEntries(projectPath, normalizePerformanceData(result));
    } catch (e) {
      console.warn('[engine:runPerformance] 诊断落盘失败:', e instanceof Error ? e.message : String(e));
    }
    return result;
  } catch (err) {
    console.error('[engine:runPerformance] Error:', err);
    return { summary: { total: 0, autoFixable: 0 }, issues: [], metadata: { duration: 0, timestamp: new Date().toISOString() } };
  }
}

async function runRefactorHandler(manager: TaskManager, projectPath: string): Promise<RefactorReport> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    // 重构分析含同步扫盘 + AST，必须离主进程，否则 macOS 彩球
    const task = manager.start('refactor', projectPath);
    const report = await manager.waitFor(task.id) as RefactorReport;
    try {
      persistDiagnosticsFromEntries(projectPath, normalizeRefactorSource(report));
    } catch (e) {
      console.warn('[engine:runRefactor] 诊断落盘失败:', e instanceof Error ? e.message : String(e));
    }
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
 * 依赖管家（engine:runDeps）：纯静态解析锁文件/清单，直连主进程，
 * 不经 TaskManager / worker。返回依赖图谱 + 许可证矩阵 + 投毒检测 +
 * 锁文件校验 + 升级评估 + 环境一致性报告。
 */
async function runDepsHandler(projectPath: string): Promise<DependencyReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const graph = buildDependencyGraph(projectPath);
    const matrix = buildLicenseMatrix(graph);
    const nodes = graph.nodes;
    const [typosquat, lockfileCheck, upgrade, env] = await Promise.all([
      runTyposquatChecks(graph),
      runLockfileChecks(projectPath),
      runUpgradeChecks(nodes),
      runEnvConsistencyChecks(projectPath),
    ]);
    return {
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
  } catch (err) {
    console.error('[engine:runDeps] Error:', err);
    return emptyDepsReport(err instanceof Error ? err.message : String(err));
  }
}

/** 投毒检测接线：单适配器失败 → 空数组 + error，不阻断整个盘点 */
async function runTyposquatChecks(graph: DependencyGraph): Promise<{ findings: TyposquatFinding[]; error?: string }> {
  try {
    const detector = new TyposquatDetectorImpl();
    return { findings: await detector.detect(graph) };
  } catch (err) {
    console.warn('[engine:runDeps] 投毒检测失败:', err instanceof Error ? err.message : String(err));
    return { findings: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 锁文件完整性校验接线：校验器契约不抛异常，兜底为 missing + error */
async function runLockfileChecks(projectPath: string): Promise<{ verification: LockfileVerification; error?: string }> {
  try {
    return { verification: await lockfileVerifier.verify(projectPath) };
  } catch (err) {
    console.warn('[engine:runDeps] 锁文件校验失败:', err instanceof Error ? err.message : String(err));
    return {
      verification: { status: 'missing', diffs: [], integrityFailures: [] },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 升级评估接线：仅 direct 依赖且命中内置升级目录，不做 code-scan 防主进程阻塞 */
async function runUpgradeChecks(nodes: readonly DependencyNode[]): Promise<{ assessments: UpgradeAssessment[]; error?: string }> {
  try {
    const evaluator = new UpgradeEvaluatorImpl();
    const directNodes = nodes.filter((node) => node.kind === 'direct' && node.name in DEFAULT_UPGRADE_CATALOG);
    const assessments: UpgradeAssessment[] = [];
    for (const node of directNodes) {
      assessments.push(await evaluator.evaluate(node));
    }
    return { assessments };
  } catch (err) {
    console.warn('[engine:runDeps] 升级评估失败:', err instanceof Error ? err.message : String(err));
    return { assessments: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 环境一致性检查接线：从 projectPath 推导 ProjectProfile（detectProjectProfile 同步 fs，移入 profile worker 执行） */
async function runEnvConsistencyChecks(projectPath: string): Promise<{ entries: EnvEntry[]; error?: string }> {
  try {
    const checker = new EnvConsistencyCheckerImpl();
    const profile = (await detectProfileInWorker(projectPath)) as ProjectProfile;
    const report = await checker.check(profile);
    return { entries: report.entries };
  } catch (err) {
    console.warn('[engine:runDeps] 环境一致性检查失败:', err instanceof Error ? err.message : String(err));
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
        const hotness = Array.from(counts.entries(), ([module, commitCount]) => ({ module, commitCount }))
          .sort((a, b) => b.commitCount - a.commitCount);
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
async function runTechDebtHandler(manager: TaskManager, projectPath: string): Promise<TechDebtReportData> {
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
        actionList: mergeActionStatuses(snapshot.actionList, persisted.map((row) => ({ actionId: row.action_id, status: row.status }))),
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
      console.warn('[engine:runTechDebt] 债务状态持久化不可用，降级为纯计算:', err instanceof Error ? err.message : String(err));
    }
    return { ...finalSnapshot, error: null };
  } catch (err) {
    console.error('[engine:runTechDebt] Error:', err);
    return emptyTechDebtReport(err instanceof Error ? err.message : String(err));
  }
}

async function planDebtRepaymentHandler(manager: TaskManager, projectPath: string, actionId: string, opts?: { sprint?: string; gate?: 'allow-with-record' }): Promise<void> {
  try {
    if (!projectPath || typeof projectPath !== 'string' || !actionId || typeof actionId !== 'string') {
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
    const snapshot = buildTechDebtDashboard({ projectId: inspectReport.projectId, issues, moduleHotness, exposedFiles });
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
    console.warn('[engine:debt:planRepayment] 计划偿还失败:', err instanceof Error ? err.message : String(err));
  }
}

async function verifyDebtRepaidHandler(manager: TaskManager, projectPath: string, actionId: string): Promise<boolean> {
  try {
    if (!projectPath || typeof projectPath !== 'string' || !actionId || typeof actionId !== 'string') return false;
    const inspectReport = await runInspectTask(manager, projectPath);
    const issues: DebtIssueInput[] = inspectReport.issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      category: issue.category,
      file: issue.file,
    }));
    const moduleHotness = await collectModuleHotness(projectPath);
    const exposedFiles = await collectExposedFilesInWorker(projectPath);
    const snapshot = buildTechDebtDashboard({ projectId: inspectReport.projectId, issues, moduleHotness, exposedFiles });
    const stillPresent = snapshot.actionList.some((a) => a.actionId === actionId);
    if (stillPresent) return false;
    const db = getDb();
    updateDebtActionStatus(db, { projectId: snapshot.projectId, actionId, status: 'repaid' });
    return true;
  } catch (err) {
    console.warn('[engine:debt:verifyRepaid] 验证失败:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function dismissDebtActionHandler(projectPath: string, actionId: string): Promise<void> {
  try {
    if (!projectPath || typeof projectPath !== 'string' || !actionId || typeof actionId !== 'string') return;
    const db = getDb();
    updateDebtActionStatus(db, { projectId: projectPath, actionId, status: 'dismissed' });
  } catch (err) {
    console.warn('[engine:debt:dismiss] 忽略操作失败:', err instanceof Error ? err.message : String(err));
  }
}

/** 各项目已实例化的密钥生命周期管理器（key = projectPath，状态变更按 secretId 反查项目） */
const secretManagers = new Map<string, { manager: SecretLifecycleManager; store: FileSecretStore }>();

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
    return { ...report, error: null };
  } catch (err) {
    console.error('[engine:runSecrets] Error:', err);
    return emptySecretsReport(err instanceof Error ? err.message : String(err));
  }
}

/** 按 secretId 反查持有该密钥状态的项目管理器；未找到返回 undefined（对应渲染层静默成功/返回 false） */
async function findSecretManager(secretId: string): Promise<{ manager: SecretLifecycleManager } | undefined> {
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
    const report = await manager.waitFor(task.id) as PipelineReport;
    if (!options?.dryRun) {
      try {
        const diagnosticsPath = persistDiagnostics(projectPath, report);
        void triggerOpenCodeAutoFix(projectPath, diagnosticsPath);
      } catch (err) {
        console.warn('[engine:runPipeline] 诊断文件写入失败:', err instanceof Error ? err.message : String(err));
      }
      recordPipelineScore(projectPath, report);
    }
    return report;
  } catch (err) {
    console.error('[engine:runPipeline] 流水线执行异常:', err instanceof Error ? err.stack || err.message : String(err));
    return createReport({
      stage: 'failed',
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runProfileHandler(projectPath: string): Promise<unknown> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error(t('electron.invalidProjectPath'));
  }
  // 画像探测含全量同步扫盘（@zh/fingerprint detectors），必须离主进程，否则 macOS 彩球
  return runProfileInWorker(projectPath);
}

async function getScoreHandler(_event: Electron.IpcMainInvokeEvent, projectId: string): Promise<HealthScoreData | null> {
  try {
    const scoring = await getScoring();
    const score = scoring.getCurrent(projectId);
    return score ? toHealthScoreData(score) : null;
  } catch (err) {
    console.warn('[engine:getScore] 评分读取失败:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function getScoreHistoryHandler(_event: Electron.IpcMainInvokeEvent, projectId: string): Promise<HealthScoreData[]> {
  try {
    const scoring = await getScoring();
    return scoring.getHistory(projectId).map(toHealthScoreData);
  } catch (err) {
    console.warn('[engine:getScoreHistory] 评分历史读取失败:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** 项目画像（含子模块列表）：供报告页列出模块用于模块级评分卡展示；探测失败时返回 null */
async function getProfileHandler(_event: Electron.IpcMainInvokeEvent, projectPath: string): Promise<ProjectProfileData | null> {
  try {
    const profilingResult = profileSync(projectPath).profile;
    return {
      type: profilingResult.type,
      modules: (profilingResult.modules ?? []).map((m) => ({ path: m.path, type: m.type })),
    };
  } catch (err) {
    console.warn('[engine:getProfile] 画像探测失败:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
