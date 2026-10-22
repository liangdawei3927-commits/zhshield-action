/**
 * 引擎 API 分片 — Refactor 重构引擎：发起重构扫描
 *
 * HTTP 模式直连服务端接口；IPC 无引擎时返回空报告兜底。
 */
import type { RefactorReportData } from '../types/electron';
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
