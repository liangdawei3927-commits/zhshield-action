/**
 * 引擎 API 分片 — Security 安全引擎：发起安全扫描
 *
 * HTTP 模式直连服务端接口；IPC 无引擎时返回空报告兜底。
 */
import type { SecurityScanReportData } from '../types/electron';
import { runSecurityViaHttp } from './serverApi';
import { emptySecurityScanReportData } from './empty-engine-reports';
import { isHttpMode, getAPI } from './engineApi-transport';

// ─── Security 安全引擎 ─────────────────────────────────────

export async function runSecurity(projectPath: string): Promise<SecurityScanReportData> {
  if (isHttpMode()) return runSecurityViaHttp(projectPath);
  const api = getAPI();
  if (!api?.engine) {
    return emptySecurityScanReportData();
  }
  return api.engine.runSecurity(projectPath);
}
