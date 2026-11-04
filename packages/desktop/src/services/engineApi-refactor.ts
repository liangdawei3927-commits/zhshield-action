/**
 * 引擎 API 分片 — Refactor 重构引擎：发起重构扫描
 *
 * HTTP 模式直连服务端接口；IPC 无引擎时返回空报告兜底。
 */
import type {
  RefactorReportData,
  RefactorAutoFixResultData,
  RefactorAutoFixBackupEntryData,
  RestoreRefactorAutoFixResultData,
} from '../types/electron';
import { runRefactorViaHttp } from './serverApi';
import { isHttpMode, getAPI } from './engineApi-transport';

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

/**
 * 一键应用自动修复（写用户源码文件）。
 *
 * 仅桌面端（IPC）可用：主进程在子进程里扫描→生成补丁→**备份**→写盘，
 * 备份在 `.zhshield/backups/refactor-autofix-<时间戳>/`，可整目录回滚。
 * Web/HTTP 模式不提供（写的是服务端文件系统，语义不同），直接报错而非静默。
 */
export async function applyRefactorFixes(projectPath: string): Promise<RefactorAutoFixResultData> {
  if (isHttpMode()) {
    throw new Error('远端（Web）模式暂不支持一键应用，请在桌面端操作');
  }
  const api = getAPI();
  if (!api?.engine?.applyRefactorFixes) {
    throw new Error('当前环境不支持一键应用自动修复');
  }
  return api.engine.applyRefactorFixes(projectPath);
}

/**
 * 列出仍可撤销的自动修复备份（新→旧）。数据来自磁盘 manifest，跨会话有效。
 *
 * Web/HTTP 模式返回空数组（服务端文件系统语义不同，不提供撤销）。
 */
export async function listRefactorAutoFixBackups(
  projectPath: string,
): Promise<RefactorAutoFixBackupEntryData[]> {
  if (isHttpMode()) return [];
  const api = getAPI();
  if (!api?.engine?.listRefactorAutoFixBackups) return [];
  return api.engine.listRefactorAutoFixBackups(projectPath);
}

/**
 * 撤销一次自动修复（按备份恢复，幂等 + 逐字节校验）。
 *
 * 仅桌面端（IPC）可用；Web 模式直接报错而非静默 —— 静默会让人以为撤销成功。
 */
export async function restoreRefactorAutoFix(
  projectPath: string,
  backupDir: string,
): Promise<RestoreRefactorAutoFixResultData> {
  if (isHttpMode()) {
    throw new Error('远端（Web）模式暂不支持撤销，请在桌面端操作');
  }
  const api = getAPI();
  if (!api?.engine?.restoreRefactorAutoFix) {
    throw new Error('当前环境不支持撤销自动修复');
  }
  return api.engine.restoreRefactorAutoFix(projectPath, backupDir);
}
