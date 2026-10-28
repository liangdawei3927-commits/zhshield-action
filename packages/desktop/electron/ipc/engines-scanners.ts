/**
 * 扫描型引擎处理器（ipc/engines-scanners.ts）
 *
 * Security / Refactor / Garbage 处理器与各域 dashboard-state patch，
 * 以及 opencode 自动修复（ai-auto-fix）的辅助函数。
 * 由 engines.ts 引用，依赖方向单向：engines.ts → 本文件（本文件不得 import engines.ts）。
 */

import path from 'node:path';
import os from 'node:os';
import { constants as FS_CONSTANTS } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { t } from '@zh/i18n';
import { safeJoin } from '@zh/shared';
import type { SecurityScanReport } from '@zh/security';
import type { RefactorReport } from '@zh/refactor';
import type { GarbageScanReport, GarbageCleanResult, GarbageRestoreResult } from '@zh/garbage';
import {
  persistDiagnosticsFromEntries,
  persistSecurityDomainEntries,
  mergeSecurityEntries,
  readDomainSnapshot,
  normalizeSecuritySource,
  normalizeRefactorSource,
} from '../zh-diagnostics';
import {
  readDashboardState,
  updateDashboardState,
  type DashboardRefactorState,
  type DashboardPerformanceState,
  type DashboardGarbageState,
} from './dashboard-state';
import { buildFixPrompt, resolveOpenCodeModel } from '../ai-auto-fix';
import { validateGarbageCleanItems, isValidBatchId } from '../garbage-input';
import { sendProgress } from '../ipc-context';
import type { TaskManager } from '../task-manager';
import { rethrowIfCancelled } from '../pipeline-protocol';
import { computeDomainSnapshotScore } from '../domain-snapshot-score';
import {
  toSecurityScanReportData,
  type SecurityScanReportData,
  type PerformanceReportData,
} from './report-format';

export async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, FS_CONSTANTS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 读取诊断报告并解析为可判定 JSON */
export async function readDiagnosticsReport(diagnosticsPath: string): Promise<{
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
export async function collectOpenCodeCandidates(): Promise<
  Array<{ path: string; executable: boolean }>
> {
  const envBin = process.env.ZH_OPENCODE_BIN;
  const candidates: Array<{ path: string; executable: boolean }> = [];
  if (envBin) {
    candidates.push({ path: envBin, executable: await isExecutable(envBin) });
  }
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    // safeJoin: PATH 目录 + 固定字面量，界内行为与 path.join 完全一致（09-24 path-traversal 清理）
    const p = safeJoin(dir, 'opencode');
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
export function spawnOpenCodeFix(
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

export async function runSecurityHandler(
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
    // P2：security 域快照当场出分（与 compose-on-read 同口径）：
    // 条目 = 双路合并结果（新漏洞 + 既有密钥），activeSecrets 取 dashboard-state 同源。
    const vulnEntries = normalizeSecuritySource(data);
    const [prevSnapshot, state] = await Promise.all([
      readDomainSnapshot(projectPath, 'security').catch(() => null),
      readDashboardState(projectPath).catch(() => null),
    ]);
    const mergedEntries = mergeSecurityEntries(
      prevSnapshot?.issues ?? [],
      vulnEntries,
      'vuln',
    );
    const activeSecrets = state?.secrets?.activeCount ?? null;
    const dimensionScore = computeDomainSnapshotScore({
      dimension: 'security',
      entries: mergedEntries,
      activeSecrets,
    });
    try {
      // P1-6: 安全域条目只归 vuln 类，覆盖 vuln、保留 secrets 已写的 secret 条目
      await persistSecurityDomainEntries(projectPath, vulnEntries, 'vuln', dimensionScore);
    } catch (e) {
      console.warn(
        '[engine:runSecurity] 诊断落盘失败:',
        e instanceof Error ? e.message : String(e),
      );
    }
    return data;
  } catch (err) {
    rethrowIfCancelled(err); // 用户点「停止」不是失败：原样抛给渲染层静默处理
    // P1-B：失败不再返回空报告。空报告 = 0 问题 = 满分 100，
    // 会把「没查成」伪装成「干净」；抛错让渲染层走失败路径（宁可红不可假绿）。
    console.error('[engine:runSecurity] Error:', err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** 十域评分：清理完成后按已清理条目递减 dashboard-state 里的 garbage 计数；失败仅告警，不阻断清理 */
export async function syncGarbageDashboard(
  projectPath: string,
  result: GarbageCleanResult,
): Promise<void> {
  try {
    const state = await readDashboardState(projectPath);
    if (!state.garbage) return;
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
  } catch (e) {
    console.warn(
      '[engine:garbageClean] dashboard-state 更新失败:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

export async function garbageCleanHandler(
  manager: TaskManager,
  projectPath: string,
  items: unknown,
): Promise<GarbageCleanResult> {
  // 边界校验：渲染进程入参不可信（同源 XSS 可提交任意 payload）。
  // 校验失败必须在 try 之外抛出，使 IPC invoke 直接 reject，绝不把脏数据交给清理器。
  const validated = validateGarbageCleanItems(items);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const task = manager.start('garbageClean', projectPath, { items: validated.items });
    const result = (await manager.waitFor(task.id)) as GarbageCleanResult;
    await syncGarbageDashboard(projectPath, result);
    return result;
  } catch (err) {
    rethrowIfCancelled(err); // 用户点「停止」不是失败：原样抛给渲染层静默处理
    console.error('[engine:garbageClean] Error:', err);
    return { batchId: '', cleaned: [], freedBytes: 0, failed: [t('electron.cleanFailed')] };
  }
}

export async function garbageRestoreHandler(
  manager: TaskManager,
  projectPath: string,
  batchId: string,
): Promise<GarbageRestoreResult> {
  // 边界校验：batchId 必须是规范 UUID（产品侧由 randomUUID 生成）。
  // 在 try 之外抛出，使非法 batchId 的 IPC invoke 直接 reject，不进入恢复流程。
  if (!isValidBatchId(batchId)) {
    throw new Error(t('electron.invalidParams'));
  }
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidParams'));
    }
    const task = manager.start('garbageRestore', projectPath, { batchId });
    const result = (await manager.waitFor(task.id)) as GarbageRestoreResult;
    return result;
  } catch (err) {
    rethrowIfCancelled(err); // 用户点「停止」不是失败：原样抛给渲染层静默处理
    console.error('[engine:garbageRestore] Error:', err);
    return { restored: 0, restoredBytes: 0, failed: [t('electron.restoreFailed')] };
  }
}

export async function runRefactorHandler(
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

/** 从 RefactorReport 提取 refactor 域 dashboard-state patch */
function refactorDashboardPatch(report: RefactorReport): DashboardRefactorState {
  const bySeverity = {
    error: report.bySeverity.error ?? 0,
    warning: report.bySeverity.warning ?? 0,
    info: report.bySeverity.info ?? 0,
  };
  // P1-9：保留扫描覆盖数——0 文件是"没扫到"不是"干净"，评分侧据此判 not-run
  return {
    totalSmells: report.totalSmells,
    bySeverity,
    scannedFiles: report.scannedFiles,
    lastRunAt: new Date().toISOString(),
  };
}

/** 从 PerformanceReportData 提取 performance 域 dashboard-state patch */
export function performanceDashboardPatch(
  report: PerformanceReportData,
): DashboardPerformanceState {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const issue of report.issues) {
    const key = issue.severity as keyof typeof counts;
    if (key in counts) counts[key]++;
  }
  return { total: report.summary.total, bySeverity: counts, lastRunAt: new Date().toISOString() };
}

/** 从 GarbageScanReport 提取 garbage 域 dashboard-state patch（十域评分章程 #5） */
export function garbageDashboardPatch(report: GarbageScanReport): DashboardGarbageState {
  return {
    total: report.summary.total,
    byType: { ...report.summary.byType },
    lastRunAt: new Date().toISOString(),
  };
}
