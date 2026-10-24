/**
 * 引擎 API 分片 — SOP 规则同步：版本查询、规则同步、同步健康度与统计
 *
 * HTTP 模式部分能力直连服务端接口；IPC 桥接缺失或异常时返回默认值兜底。
 */
import { getRuleVersionViaHttp } from './serverApi';
import { isHttpMode, getAPI } from './engineApi-transport';
import type { SopSyncHealth } from '../types/electron';

function getSopAPI() {
  return window.electronAPI?.sop;
}

// ─── SOP 规则同步 ─────────────────────────────────────────

/** SOP 规则版本；`sop:getVersion` IPC 链路已实现，UI 未接入。 */
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
    const api = getAPI();
    if (!api?.sync) return { added: 0, updated: 0 };
    const result = (await api.sync.syncRules()) as Array<{
      toolId: string;
      stale: boolean;
    }>;
    const updated = result.filter((r) => r.stale).length;
    return { added: result.length, updated };
  } catch {
    return { added: 0, updated: 0 };
  }
}

/**
 * 同步健康度；不可用时给出「从未接入」形态而非「已过期」。
 *
 * HTTP 模式与 IPC 缺失都意味着这台客户端根本没有同步通道，
 * 语义是「未接入云端」而不是「同步过期 28 天」——后者会误导用户去查网络。
 */
function unknownSyncHealth(): SopSyncHealth {
  return {
    level: 4,
    everSucceeded: false,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
    daysSinceSuccess: null,
    failureKind: 'none',
  };
}

export async function getSyncHealth(): Promise<SopSyncHealth> {
  if (isHttpMode()) return unknownSyncHealth();
  try {
    const api = getSopAPI();
    if (!api) return unknownSyncHealth();
    return await api.getSyncHealth();
  } catch {
    return unknownSyncHealth();
  }
}

/** SOP 统计；`sop:getStats` IPC 链路已实现，UI 未接入。 */
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
