/**
 * 引擎 API 服务 — 根据运行环境自动选择传输层
 *
 * 三种模式：
 *   1. IPC — Electron 主进程（window.electronAPI 存在时）
 *   2. HTTP — 连接远程服务端（VITE_API_BASE 环境变量时）
 *   3. Mock — 纯浏览器开发环境，返回空数据
 */
import { t } from '@zh/i18n';
import type {
  GuardReportData,
  GuardReportRecordData,
  GuardConfig,
  InspectionReportData,
  SecurityScanReportData,
  PerformanceReportData,
  HealthScoreData,
  ProjectProfileData,
  RefactorReportData,
  PipelineReportData,
  SuggestionData,
  RuleWeightData,
  BackupRecordData,
  BackupResultData,
  BackupConfigData,
  GarbageCleanResultData,
  GarbageRestoreResultData,
  FalsePositiveFeedbackRecord,
  DependencyReportData,
  DepsRelockResult,
  TechDebtReportData,
  SecretReportData,
} from '../types/electron';
import type { SentinelEvent } from '@zh/sentinel';
import {
  runGuardViaHttp,
  runInspectViaHttp,
  runSecurityViaHttp,
  getScoreViaHttp,
  getScoreHistoryViaHttp,
  runRefactorViaHttp,
  runPipelineViaHttp,
  getRuleVersionViaHttp,
  getSentinelEventsViaHttp,
  startSentinelViaHttp,
  getEvolveSuggestionsViaHttp,
  getEvolveWeightsViaHttp,
  autoAdjustWeightsViaHttp,
  runBackupViaHttp,
  getBackupRecordsViaHttp,
  getBackupRecordViaHttp,
  deleteBackupRecordViaHttp,
  getBackupConfigViaHttp,
  saveBackupConfigViaHttp,
} from './serverApi';

// ─── 模式检测 ─────────────────────────────────────────────

function isHttpMode(): boolean {
  try {
    return typeof import.meta !== 'undefined' && !!import.meta.env?.VITE_API_BASE;
  } catch {
    return false;
  }
}

function getAPI() {
  return window.electronAPI;
}

// ─── Guard 门禁引擎 ────────────────────────────────────────

export async function runGuard(projectPath: string): Promise<GuardReportData> {
  if (isHttpMode()) return runGuardViaHttp(projectPath);
  const api = getAPI();
  if (!api?.engine) {
    return {
      summary: { totalChecks: 0, passed: 0, blocked: 0, warnings: 0 },
      checks: [],
      metadata: { duration: 0, timestamp: new Date().toISOString() },
    };
  }
  return api.engine.runGuard(projectPath);
}

// ─── 门禁 git hooks（本地自动守护）─────────────────────────

export interface GuardHooksStatusData {
  hasGitDir: boolean;
  installed: string[];
}

export interface GuardHooksInstallResultData {
  ok: boolean;
  installed: string[];
  skipped: string[];
  reason?: string;
}

export async function getGuardHooksStatus(projectPath: string): Promise<GuardHooksStatusData> {
  const api = getAPI();
  if (!api?.guardHooks) return { hasGitDir: false, installed: [] };
  return api.guardHooks.getStatus(projectPath);
}

export async function installGuardHooks(projectPath: string): Promise<GuardHooksInstallResultData> {
  const api = getAPI();
  if (!api?.guardHooks)
    return { ok: false, installed: [], skipped: [], reason: t('engine.hooksUnavailable') };
  return api.guardHooks.install(projectPath);
}

export async function uninstallGuardHooks(
  projectPath: string,
): Promise<{ ok: boolean; removed: string[] }> {
  const api = getAPI();
  if (!api?.guardHooks) return { ok: false, removed: [] };
  return api.guardHooks.uninstall(projectPath);
}

export async function listGuardReports(
  projectPath: string,
  limit = 20,
): Promise<GuardReportRecordData[]> {
  const api = getAPI();
  if (!api?.guardHooks) return [];
  return api.guardHooks.listReports(projectPath, limit);
}

const DEFAULT_GUARD_CONFIG: GuardConfig = {
  enabled: true,
  preCommit: true,
  prePush: true,
  blockOnCritical: true,
};

export async function readGuardConfig(): Promise<GuardConfig> {
  const api = getAPI();
  if (!api?.guardConfig) return DEFAULT_GUARD_CONFIG;
  try {
    return await api.guardConfig.read();
  } catch {
    return DEFAULT_GUARD_CONFIG;
  }
}

export async function writeGuardConfig(config: GuardConfig): Promise<void> {
  const api = getAPI();
  if (!api?.guardConfig) return;
  await api.guardConfig.write(config);
}

// ─── 误报反馈（门禁 / 哨兵标记误报，落盘供智汇大脑校准）───

export interface FalsePositiveFeedbackItem {
  source: 'guard' | 'sentinel';
  ruleId: string;
  title?: string;
  message: string;
  severity?: string;
  file?: string;
  line?: number;
}

export async function reportFalsePositive(
  projectPath: string,
  item: FalsePositiveFeedbackItem,
): Promise<{ ok: boolean; id?: string; reason?: string }> {
  const api = getAPI();
  if (!api?.feedback) return { ok: false, reason: t('engine.feedbackUnavailable') };
  return api.feedback.reportFalsePositive(projectPath, item);
}

export async function listFalsePositives(
  projectPath: string,
  source?: 'guard' | 'sentinel',
): Promise<FalsePositiveFeedbackRecord[]> {
  const api = getAPI();
  if (!api?.feedback) return [];
  return api.feedback.listFalsePositives(projectPath, source);
}

// ─── Inspect 巡检引擎 ──────────────────────────────────────

export async function runInspect(projectPath: string): Promise<InspectionReportData> {
  if (isHttpMode()) return runInspectViaHttp(projectPath);
  const api = getAPI();
  if (!api?.engine) {
    return {
      summary: { total: 0, passed: 0, warnings: 0, failures: 0 },
      checks: [],
      metadata: { duration: 0, timestamp: new Date().toISOString() },
    };
  }
  return api.engine.runInspect(projectPath);
}

// ─── Security 安全引擎 ─────────────────────────────────────

export async function runSecurity(projectPath: string): Promise<SecurityScanReportData> {
  if (isHttpMode()) return runSecurityViaHttp(projectPath);
  const api = getAPI();
  if (!api?.engine) {
    return {
      summary: {
        total: 0,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        malwareTotal: 0,
        garbageTotal: 0,
        garbageSize: 0,
      },
      findings: [],
      malware: [],
      garbage: [],
      securityScore: 100,
      metadata: { duration: 0, timestamp: new Date().toISOString() },
    };
  }
  return api.engine.runSecurity(projectPath);
}

// ─── 垃圾清理 ───────────────────────────────────────────

export async function cleanGarbage(
  projectPath: string,
  items: Array<{ id: string; path: string; size: number; type: string }>,
): Promise<GarbageCleanResultData> {
  if (isHttpMode())
    return {
      batchId: '',
      cleaned: [],
      freedBytes: 0,
      failed: [t('engine.remoteCleanUnsupported')],
    };
  const api = getAPI();
  if (!api?.engine)
    return { batchId: '', cleaned: [], freedBytes: 0, failed: [t('engine.engineUnavailable')] };
  return api.engine.cleanGarbage(projectPath, items);
}

export async function restoreGarbage(
  projectPath: string,
  batchId: string,
): Promise<GarbageRestoreResultData> {
  if (isHttpMode())
    return { restored: 0, restoredBytes: 0, failed: [t('engine.remoteRestoreUnsupported')] };
  const api = getAPI();
  if (!api?.engine)
    return { restored: 0, restoredBytes: 0, failed: [t('engine.engineUnavailable')] };
  return api.engine.restoreGarbage(projectPath, batchId);
}

// ─── Performance 性能优化引擎 ─────────────────────────────

export async function runPerformance(projectPath: string): Promise<PerformanceReportData> {
  const api = getAPI();
  if (!api?.engine) {
    return {
      summary: { total: 0, autoFixable: 0 },
      issues: [],
      metadata: { duration: 0, timestamp: new Date().toISOString() },
    };
  }
  return api.engine.runPerformance(projectPath);
}

// ─── Dependency 依赖管家引擎 ─────────────────────────────

export async function runDeps(projectPath: string): Promise<DependencyReportData> {
  const api = getAPI();
  if (!api?.engine) {
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
      error: t('engine.engineUnavailable'),
    };
  }
  return api.engine.runDeps(projectPath);
}

/** 显式重锁依赖哈希基线（引擎无可用时返回错误，不 throw） */
export async function depsRelockBaseline(projectPath: string): Promise<DepsRelockResult> {
  const api = getAPI();
  if (!api?.engine) {
    return { ok: false, error: t('engine.engineUnavailable') };
  }
  return api.engine.depsRelockBaseline(projectPath);
}

// ─── Tech Debt 技术债仪表盘引擎 ────────────────────────────

export async function runTechDebt(projectPath: string): Promise<TechDebtReportData> {
  const api = getAPI();
  if (!api?.engine) {
    return {
      projectId: '',
      generatedAt: new Date().toISOString(),
      debtIndex: 0,
      trend: { period: 'week', delta: 0 },
      byModule: [],
      byCategory: [],
      actionList: [],
      error: t('engine.engineUnavailable'),
    };
  }
  return api.engine.runTechDebt(projectPath);
}

export async function planDebtRepayment(
  projectPath: string,
  actionId: string,
  opts?: { sprint?: string; gate?: 'allow-with-record' },
): Promise<void> {
  const api = getAPI();
  if (!api?.engine) return;
  return api.engine.planDebtRepayment(projectPath, actionId, opts);
}

export async function verifyDebtRepaid(projectPath: string, actionId: string): Promise<boolean> {
  const api = getAPI();
  if (!api?.engine) return false;
  return api.engine.verifyDebtRepaid(projectPath, actionId);
}

export async function dismissDebtAction(projectPath: string, actionId: string): Promise<void> {
  const api = getAPI();
  if (!api?.engine) return;
  return api.engine.dismissDebtAction(projectPath, actionId);
}

// ─── Secrets 密钥全生命周期引擎 ────────────────────────────

export async function runSecrets(projectPath: string): Promise<SecretReportData> {
  const api = getAPI();
  if (!api?.engine) {
    return {
      findings: [],
      summary: { total: 0, critical: 0, active: 0, historyFound: 0 },
      lastScannedCommit: '',
      error: t('engine.engineUnavailable'),
    };
  }
  return api.engine.runSecrets(projectPath);
}

export async function markSecretRotating(secretId: string): Promise<void> {
  const api = getAPI();
  if (!api?.engine) return;
  return api.engine.markSecretRotating(secretId);
}

export async function verifySecretRotated(secretId: string): Promise<boolean> {
  const api = getAPI();
  if (!api?.engine) return false;
  return api.engine.verifySecretRotated(secretId);
}

export async function dismissSecret(secretId: string, reason: string): Promise<void> {
  const api = getAPI();
  if (!api?.engine) return;
  return api.engine.dismissSecret(secretId, reason);
}

// ─── Scoring 评分引擎 ──────────────────────────────────────

export async function getScore(projectId: string): Promise<HealthScoreData | null> {
  if (isHttpMode()) return getScoreViaHttp(projectId);
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.getScore(projectId);
  } catch {
    return null;
  }
}

export async function getScoreHistory(projectId: string): Promise<HealthScoreData[]> {
  if (isHttpMode()) return getScoreHistoryViaHttp(projectId);
  const api = getAPI();
  if (!api?.engine) return [];
  try {
    return await api.engine.getScoreHistory(projectId);
  } catch {
    return [];
  }
}

/** 项目画像（含子模块列表），供报告页展示模块级评分卡；HTTP 模式服务端未暴露画像接口时返回 null */
export async function getProfile(projectPath: string): Promise<ProjectProfileData | null> {
  if (isHttpMode()) return null;
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.getProfile(projectPath);
  } catch {
    return null;
  }
}

// ─── Refactor 重构引擎 ──────────────────────────────────────

export async function runRefactor(projectPath: string): Promise<RefactorReportData> {
  if (isHttpMode()) return runRefactorViaHttp(projectPath);
  const api = getAPI();
  if (!api?.engine) {
    return {
      timestamp: new Date().toISOString(),
      projectRoot: projectPath,
      totalFiles: 0,
      scannedFiles: 0,
      totalSmells: 0,
      byCategory: { structural: 0, coupling: 0, inheritance: 0 },
      bySeverity: { error: 0, warning: 0, info: 0 },
      files: [],
      summary: { criticalFiles: 0, needsImmediateAction: 0, suggestionsByType: {} },
    };
  }
  return api.engine.runRefactor(projectPath);
}

// ─── Pipeline 流水线引擎 ──────────────────────────────────

export async function runPipeline(
  projectPath: string,
  options?: { dryRun?: boolean; sop?: boolean; presetName?: string },
): Promise<PipelineReportData> {
  if (isHttpMode()) return runPipelineViaHttp(projectPath, options);
  const api = getAPI();
  if (!api?.engine) {
    return {
      passed: false,
      stage: 'idle',
      timestamp: new Date().toISOString(),
      error: 'IPC not available',
    };
  }
  return api.engine.runPipeline(projectPath, options);
}

// ─── Sentinel 哨兵监控 ────────────────────────────────────

export async function getSentinelEvents(options?: {
  status?: string;
  severity?: string;
}): Promise<SentinelEvent[]> {
  if (isHttpMode()) return getSentinelEventsViaHttp(options);
  const api = getAPI();
  if (!api?.sentinel) return [];
  return api.sentinel.getEvents(options);
}

export async function startSentinelMonitoring(
  projectPath: string,
): Promise<{ ok: boolean; started: string[]; disabled?: boolean }> {
  if (isHttpMode()) return startSentinelViaHttp(projectPath);
  const api = getAPI();
  if (!api?.sentinel) return { ok: false, started: [] };
  return api.sentinel.startMonitoring(projectPath, projectPath);
}

export async function getSentinelState(): Promise<{ enabled: boolean }> {
  const api = getAPI();
  if (!api?.sentinel) return { enabled: true };
  try {
    return await api.sentinel.getState();
  } catch {
    return { enabled: true };
  }
}

export async function setSentinelEnabled(enabled: boolean): Promise<{ ok: boolean }> {
  const api = getAPI();
  if (!api?.sentinel) return { ok: false };
  return api.sentinel.setEnabled(enabled);
}

// ─── Evolve 演进引擎 ──────────────────────────────────────

export async function getEvolveSuggestions(projectId: string): Promise<SuggestionData[]> {
  if (isHttpMode()) return getEvolveSuggestionsViaHttp(projectId);
  const api = getAPI();
  if (!api?.evolve) return [];
  return api.evolve.getSuggestions(projectId);
}

export async function getEvolveRuleWeights(): Promise<RuleWeightData[]> {
  if (isHttpMode()) return getEvolveWeightsViaHttp();
  const api = getAPI();
  if (!api?.evolve) return [];
  return api.evolve.getRuleWeights();
}

export async function autoAdjustWeights(): Promise<RuleWeightData[]> {
  if (isHttpMode()) return autoAdjustWeightsViaHttp();
  const api = getAPI();
  if (!api?.evolve) return [];
  return api.evolve.autoAdjustWeights();
}

// ─── SOP 规则同步 ─────────────────────────────────────────

function getSopAPI() {
  return window.electronAPI?.sop;
}

export async function getRuleVersion(): Promise<string> {
  if (isHttpMode()) return getRuleVersionViaHttp();
  try {
    const api = getSopAPI();
    if (!api) return '0.0.0';
    const version = await api.getVersion();
    return version?.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function syncRules(): Promise<{ added: number; updated: number }> {
  if (isHttpMode()) return { added: 0, updated: 0 };
  try {
    const api = getSopAPI();
    if (!api) return { added: 0, updated: 0 };
    const result = await api.syncNow();
    if (result.updated) {
      return { added: result.ruleCount ?? 0, updated: 1 };
    }
    return { added: 0, updated: 0 };
  } catch {
    return { added: 0, updated: 0 };
  }
}

export async function getSyncHealth(): Promise<{
  level: number;
  stale: boolean;
  lastSync: string | null;
}> {
  if (isHttpMode()) return { level: 4, stale: true, lastSync: null };
  try {
    const api = getSopAPI();
    if (!api) return { level: 4, stale: true, lastSync: null };
    return await api.getSyncHealth();
  } catch {
    return { level: 4, stale: true, lastSync: null };
  }
}

// ─── Backup 备份系统 ─────────────────────────────────────

export async function runBackup(projectPath: string, trigger?: string): Promise<BackupResultData> {
  if (isHttpMode()) return runBackupViaHttp(projectPath, trigger) as Promise<BackupResultData>;
  const api = getAPI();
  if (!api?.backup) {
    return {
      projectId: 'default',
      projectName: t('engine.unknownProject'),
      trigger: trigger ?? 'manual',
      overallStatus: 'failed',
      timestamp: new Date().toISOString(),
      duration: 0,
      error: t('engine.backupModuleUnavailable'),
      results: [],
    };
  }
  return api.backup.executeBackup(projectPath, trigger);
}

export async function getBackupRecords(projectId?: string): Promise<BackupRecordData[]> {
  if (isHttpMode()) return getBackupRecordsViaHttp(projectId) as Promise<BackupRecordData[]>;
  const api = getAPI();
  if (!api?.backup) return [];
  return api.backup.getRecords(projectId);
}

export async function getBackupRecord(recordId: string): Promise<BackupRecordData | null> {
  if (isHttpMode()) return getBackupRecordViaHttp(recordId) as Promise<BackupRecordData | null>;
  const api = getAPI();
  if (!api?.backup) return null;
  return api.backup.getRecord(recordId);
}

export async function deleteBackupRecord(recordId: string): Promise<boolean> {
  if (isHttpMode()) return deleteBackupRecordViaHttp(recordId);
  const api = getAPI();
  if (!api?.backup) return false;
  return api.backup.deleteRecord(recordId);
}

export async function getBackupConfig(projectPath: string): Promise<BackupConfigData | null> {
  if (isHttpMode()) return getBackupConfigViaHttp(projectPath) as Promise<BackupConfigData>;
  const api = getAPI();
  if (!api?.backup) return null;
  return api.backup.getConfig(projectPath);
}

export async function saveBackupConfig(
  projectPath: string,
  config: BackupConfigData,
): Promise<void> {
  if (isHttpMode()) return saveBackupConfigViaHttp(projectPath, config);
  const api = getAPI();
  if (!api?.backup) return;
  return api.backup.saveConfig(projectPath, config);
}

export async function authorizeGitHub(): Promise<boolean> {
  if (isHttpMode()) return false;
  const api = getAPI();
  if (!api?.backup) return false;
  return api.backup.authorizeGitHub();
}

export async function openBackupFolder(folderPath: string): Promise<boolean> {
  const api = getAPI();
  if (!api?.backup) return false;
  return api.backup.openFolder(folderPath);
}

export async function getSopStats() {
  if (isHttpMode()) return null;
  try {
    const api = getSopAPI();
    if (!api) return null;
    return await api.getStats();
  } catch {
    return null;
  }
}

// ─── Scheduler 调度器状态持久化 ───────────────────────────────

export interface SchedulerStateData {
  jobs: Array<{
    id: string;
    config: Record<string, unknown>;
    nextRun: string;
    lastRun?: string;
    lastStatus?: 'success' | 'failure' | 'skipped';
    createdAt: string;
  }>;
}

export async function readSchedulerState(): Promise<SchedulerStateData> {
  if (isHttpMode()) return { jobs: [] };
  const api = getAPI();
  if (!api?.scheduler) return { jobs: [] };
  return api.scheduler.readState();
}

export async function writeSchedulerState(state: SchedulerStateData): Promise<void> {
  if (isHttpMode()) return;
  const api = getAPI();
  if (!api?.scheduler) return;
  return api.scheduler.writeState(state);
}

// ─── 原生对话框 & 文件写入 ─────────────────────────────────

export async function showSaveDialog(options: {
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
}): Promise<{ canceled: boolean; filePath?: string }> {
  const api = getAPI();
  if (!api) return { canceled: true };
  return api.showSaveDialog(options);
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  const api = getAPI();
  if (!api) return;
  return api.writeFile(filePath, content);
}
