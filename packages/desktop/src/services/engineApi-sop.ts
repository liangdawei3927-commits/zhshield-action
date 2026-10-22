/**
 * 引擎 API 分片 — SOP 规则同步：版本查询、规则同步、同步健康度与统计
 *
 * HTTP 模式部分能力直连服务端接口；IPC 桥接缺失或异常时返回默认值兜底。
 */
import { getRuleVersionViaHttp } from './serverApi';
import { isHttpMode, getAPI } from './engineApi-transport';

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
