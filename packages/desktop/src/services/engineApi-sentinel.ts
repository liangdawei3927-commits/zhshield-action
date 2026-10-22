/**
 * 引擎 API 分片 — Sentinel 哨兵监控：事件查询、启停与开关状态
 *
 * HTTP 模式直连服务端接口；IPC 桥接缺失时返回空列表 / 默认状态兜底。
 */
import type { SentinelEvent } from '@zh/sentinel';
import { getSentinelEventsViaHttp, startSentinelViaHttp } from './serverApi';
import { isHttpMode, getAPI } from './engineApi-transport';

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
