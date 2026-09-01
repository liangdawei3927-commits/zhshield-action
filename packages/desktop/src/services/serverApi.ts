/**
 * 后端 HTTP API 客户端 — 直接向 NestJS 服务端发送请求
 *
 * 当 Electron IPC 不可用时（浏览器开发 / 远程连接）使用此服务。
 * 默认连接到 http://localhost:3010/api/v1
 */
import type {
  GuardReportData,
  InspectionReportData,
  SecurityScanReportData,
  HealthScoreData,
  RefactorReportData,
  PipelineReportData,
  SuggestionData,
  RuleWeightData,
  BackupRecordData,
  BackupConfigData,
} from '../types/electron';
import type { SentinelEvent } from '@zh/sentinel';

const BASE_URL = import.meta.env.VITE_API_BASE ?? 'http://localhost:3010/api/v1';
const TRAILING_SLASHES = /\/+$/;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${res.statusText}`);
  }
  const json = await res.json();
  // Server wraps data in { success, data, timestamp }
  return (json.data ?? json) as T;
}

// ─── Guard ──────────────────────────────────────────────

export async function runGuardViaHttp(
  projectPath: string,
  dryRun?: boolean,
): Promise<GuardReportData> {
  return request<GuardReportData>('/guard/check', {
    method: 'POST',
    body: JSON.stringify({ projectPath, dryRun }),
  });
}

// ─── Inspect ────────────────────────────────────────────

export async function runInspectViaHttp(projectPath: string): Promise<InspectionReportData> {
  return request<InspectionReportData>('/inspect/scan', {
    method: 'POST',
    body: JSON.stringify({ projectPath }),
  });
}

// ─── Security ───────────────────────────────────────────

export async function runSecurityViaHttp(projectPath: string): Promise<SecurityScanReportData> {
  return request<SecurityScanReportData>('/security/scan', {
    method: 'POST',
    body: JSON.stringify({ projectPath }),
  });
}

// ─── Scoring ────────────────────────────────────────────

export async function getScoreViaHttp(projectId: string): Promise<HealthScoreData | null> {
  try {
    return await request<HealthScoreData>(`/scoring/score/${projectId}`);
  } catch {
    return null;
  }
}

export async function getScoreHistoryViaHttp(projectId: string): Promise<HealthScoreData[]> {
  try {
    return await request<HealthScoreData[]>(`/scoring/history/${projectId}`);
  } catch {
    return [];
  }
}

// ─── Refactor ───────────────────────────────────────────

export async function runRefactorViaHttp(
  projectPath: string,
  mode?: 'full' | 'staged',
): Promise<RefactorReportData> {
  return request<RefactorReportData>('/refactor/scan', {
    method: 'POST',
    body: JSON.stringify({ projectPath, mode: mode ?? 'full' }),
  });
}

// ─── Pipeline ───────────────────────────────────────────

export async function runPipelineViaHttp(
  projectPath: string,
  options?: { dryRun?: boolean; sop?: boolean },
): Promise<PipelineReportData> {
  const raw = await fetch(`${BASE_URL}/pipeline/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, ...options }),
  });
  if (!raw.ok) throw new Error(`Pipeline API ${raw.status}: ${raw.statusText}`);
  const json = await raw.json();
  return json.raw ?? (json.data as PipelineReportData);
}

// ─── SOP ────────────────────────────────────────────────

interface SopVersion {
  version: string;
  knowledge: string;
  experience: string;
  malware: string;
  publishedAt: string;
}

export async function getRuleVersionViaHttp(): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}/sop/version`);
    if (!res.ok) return '0.0.0';
    const json = await res.json();
    return (json as SopVersion).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface SopStats {
  totalRules: number;
  byDomain: Record<string, number>;
  byAction: Record<string, number>;
  byStatus: Record<string, number>;
}

// ─── Sentinel ────────────────────────────────────────────

export async function getSentinelEventsViaHttp(options?: {
  status?: string;
  severity?: string;
}): Promise<SentinelEvent[]> {
  try {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.severity) params.set('severity', options.severity);
    const qs = params.toString();
    return await request<SentinelEvent[]>(`/system/sentinel/event-center${qs ? `?${qs}` : ''}`);
  } catch {
    return [];
  }
}

export async function startSentinelViaHttp(
  projectPath: string,
): Promise<{ ok: boolean; started: string[] }> {
  const started: string[] = [];
  await request('/system/sentinel/file-monitor/start', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectPath, watchPaths: [projectPath] }),
  });
  started.push('file-monitor');
  const logPaths = ['logs/app.log', 'logs/error.log', 'logs/server.log'].map(
    (p) => `${projectPath.replace(TRAILING_SLASHES, '')}/${p}`,
  );
  await request('/system/sentinel/log-collector/start', {
    method: 'POST',
    body: JSON.stringify({ projectId: projectPath, logPaths }),
  });
  started.push('log-collector');
  return { ok: true, started };
}

export async function getSopStatsViaHttp(): Promise<SopStats | null> {
  try {
    await request<SopVersion>('/sop/version');
    return { totalRules: 0, byDomain: {}, byAction: {}, byStatus: {} };
  } catch {
    return null;
  }
}

// ─── Backup ──────────────────────────────────────────────

export async function runBackupViaHttp(projectPath: string, trigger?: string): Promise<unknown> {
  return request<unknown>('/backup/execute', {
    method: 'POST',
    body: JSON.stringify({ projectPath, trigger: trigger ?? 'manual' }),
  });
}

export async function getBackupRecordsViaHttp(projectId?: string): Promise<unknown[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return request<unknown[]>(`/backup/records${qs}`);
}

export async function getBackupRecordViaHttp(recordId: string): Promise<BackupRecordData | null> {
  try {
    return await request<BackupRecordData>(`/backup/records/${recordId}`);
  } catch {
    return null;
  }
}

export async function deleteBackupRecordViaHttp(recordId: string): Promise<boolean> {
  try {
    await fetch(`${BASE_URL}/backup/records/${recordId}`, { method: 'DELETE' });
    return true;
  } catch {
    return false;
  }
}

export async function getBackupConfigViaHttp(projectPath: string): Promise<BackupConfigData> {
  return request<BackupConfigData>(`/backup/config?projectPath=${encodeURIComponent(projectPath)}`);
}

export async function saveBackupConfigViaHttp(
  projectPath: string,
  config: BackupConfigData,
): Promise<void> {
  await request('/backup/config', {
    method: 'PUT',
    body: JSON.stringify({ projectPath, config }),
  });
}

// ─── Evolve ──────────────────────────────────────────────

export async function getEvolveSuggestionsViaHttp(projectId: string): Promise<SuggestionData[]> {
  try {
    return await request<SuggestionData[]>(`/evolve/suggestions/${projectId}`);
  } catch {
    return [];
  }
}

export async function getEvolveWeightsViaHttp(): Promise<RuleWeightData[]> {
  try {
    return await request<RuleWeightData[]>('/evolve/weights');
  } catch {
    return [];
  }
}

export async function autoAdjustWeightsViaHttp(): Promise<RuleWeightData[]> {
  try {
    return await request<RuleWeightData[]>('/evolve/weights/adjust', { method: 'POST' });
  } catch {
    return [];
  }
}
