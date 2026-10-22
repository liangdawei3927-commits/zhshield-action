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
  GuardConfig,
  FalsePositiveFeedbackRecord,
  GarbageScanReportData,
  PerformanceReportData,
  TechDebtReportData,
} from '../types/electron';
import { runGuardViaHttp } from './serverApi';
import { isHttpMode, getAPI } from './engineApi-transport';

// ─── 功能分片再导出（签名与原导出完全一致，消费方无需改动）──

export type {
  GuardHooksStatusData,
  GuardHooksInstallResultData,
} from './engineApi-hooks';

export {
  getGuardHooksStatus,
  installGuardHooks,
  uninstallGuardHooks,
  listGuardReports,
} from './engineApi-hooks';

export { runSecurity } from './engineApi-security';

export { cleanGarbage, restoreGarbage } from './engineApi-garbage';

export { runRefactor } from './engineApi-refactor';

export { runPipeline } from './engineApi-pipeline';

export { runDeps, depsRelockBaseline } from './engineApi-dependency';

export {
  planDebtRepayment,
  verifyDebtRepaid,
  dismissDebtAction,
} from './engineApi-techdebt';

export {
  runSecrets,
  markSecretRotating,
  verifySecretRotated,
  dismissSecret,
} from './engineApi-secrets';

export {
  getScore,
  getDomainScore,
  getScoreHistory,
  getProfile,
  generateReportSummary,
} from './engineApi-scoring';

export {
  getSentinelEvents,
  startSentinelMonitoring,
  getSentinelState,
  setSentinelEnabled,
} from './engineApi-sentinel';

export {
  getEvolveSuggestions,
  getEvolveRuleWeights,
  autoAdjustWeights,
} from './engineApi-evolve';

export { getRuleVersion, syncRules, getSyncHealth, getSopStats } from './engineApi-sop';

export {
  runBackup,
  getBackupRecords,
  getBackupRecord,
  deleteBackupRecord,
  getBackupConfig,
  saveBackupConfig,
  authorizeGitHub,
  onBackupProgress,
  onBackupCompleted,
  onBackupFailed,
  onBackupRecordsUpdated,
  openBackupFolder,
} from './engineApi-backup';

export { showSaveDialog, writeFile } from './engineApi-dialog';

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

/** 误报反馈条目：门禁/哨兵标记的误报（规则、位置与说明），落盘供智汇大脑校准 */
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

// ─── 垃圾清理扫描（垃圾清理域自有通道）─────────────────────

export async function runGarbageScan(projectPath: string): Promise<GarbageScanReportData> {
  const api = getAPI();
  if (!api?.engine) {
    return {
      projectPath,
      items: [],
      summary: { total: 0, size: 0, byType: {} },
      checks: [],
      skipped: 0,
      timestamp: new Date().toISOString(),
    };
  }
  return api.engine.runGarbageScan(projectPath);
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

// ─── Scheduler 调度器状态持久化 ───────────────────────────────

/** 调度器状态快照：已持久化的定时任务及其上次/下次运行时间与结果 */
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

/** 读取调度器状态；`scheduler:readState` IPC 链路已实现，UI 未接入。 */
export async function readSchedulerState(): Promise<SchedulerStateData> {
  if (isHttpMode()) return { jobs: [] };
  const api = getAPI();
  if (!api?.scheduler) return { jobs: [] };
  return api.scheduler.readState();
}

/** 写入调度器状态；`scheduler:writeState` IPC 链路已实现，UI 未接入。 */
export async function writeSchedulerState(state: SchedulerStateData): Promise<void> {
  if (isHttpMode()) return;
  const api = getAPI();
  if (!api?.scheduler) return;
  return api.scheduler.writeState(state);
}
