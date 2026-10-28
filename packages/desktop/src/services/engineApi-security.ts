/**
 * 引擎 API 分片 — Security 安全引擎：发起安全扫描
 *
 * HTTP 模式直连服务端接口。引擎通道缺失（preload 未注入/环境异常）时显式失败——
 * 返回空报告会把「没查成」伪装成「0 漏洞满分」，与 P1-B 语义对齐：宁可红不可假绿。
 */
import type { SecurityScanReportData } from '../types/electron';
import { runSecurityViaHttp } from './serverApi';
import { getAPI, isHttpMode } from './engineApi-transport';
import { t } from '@zh/i18n';

// ─── Security 安全引擎 ─────────────────────────────────────

export async function runSecurity(projectPath: string): Promise<SecurityScanReportData> {
  if (isHttpMode()) return runSecurityViaHttp(projectPath);
  const api = getAPI();
  if (!api?.engine) {
    throw new Error(t('engine.engineUnavailable'));
  }
  return api.engine.runSecurity(projectPath);
}
