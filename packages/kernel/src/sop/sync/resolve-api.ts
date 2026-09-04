/**
 * 服务端 Resolve 端点客户端（resolve-api.ts）
 *
 * 纯函数调用服务端 POST /resolve/tools、POST /resolve/rules、
 * PUT /orgs/:orgId/projects/:projectId/features、GET /resolve/health。
 * 运行于 Electron MAIN 进程（Node ≥18，全局 fetch 可用）。
 *
 * 鉴权：LocalOnlyGuard 令牌 `~/.zhshield/.api-token`，通过 `x-api-token` 头传输。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { resolveApiBase } from './api-base';
import { HttpError, withRetry } from './retry';

// ─── 类型 ────────────────────────────────────────────────────

/** 服务端 ScopeProfileLike 最小投影（对齐 shared/kernel 结构） */
export interface ScopeProfileLike {
  readonly framework?: string;
  readonly language?: string;
  readonly features?: readonly string[];
}

export interface ResolveRulesResponse {
  rules: Array<{
    ruleId: string;
    version: string;
    sha: string | null;
    source: string;
  }>;
  changed: string[];
}

// ─── 令牌管理 ─────────────────────────────────────────────────

const TOKEN_FILE = path.join(os.homedir(), '.zhshield', '.api-token');

/**
 * 读取本地 API 令牌；不存在则创建随机 hex 令牌并以 0o600 权限写入。
 * 与 LocalOnlyGuard 的文件路径 & 生成语义完全匹配。
 */
export function readApiToken(): string {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
  }

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

// ─── HTTP 层 ──────────────────────────────────────────────────

async function apiPost<T>(
  endpoint: string,
  body: Record<string, unknown>,
  apiBaseOverride?: string,
): Promise<T> {
  const apiBase = resolveApiBase(apiBaseOverride);
  const token = readApiToken();

  const res = await withRetry(async () => {
    const r = await fetch(`${apiBase}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new HttpError(r.status);
    return r;
  });

  return (await res.json()) as T;
}

async function apiGet<T>(endpoint: string, apiBaseOverride?: string): Promise<T> {
  const apiBase = resolveApiBase(apiBaseOverride);
  const token = readApiToken();

  const res = await withRetry(async () => {
    const r = await fetch(`${apiBase}${endpoint}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-token': token,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new HttpError(r.status);
    return r;
  });

  return (await res.json()) as T;
}

async function apiPut<T>(
  endpoint: string,
  body: Record<string, unknown>,
  apiBaseOverride?: string,
): Promise<T> {
  const apiBase = resolveApiBase(apiBaseOverride);
  const token = readApiToken();

  const res = await withRetry(async () => {
    const r = await fetch(`${apiBase}${endpoint}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new HttpError(r.status);
    return r;
  });

  return (await res.json()) as T;
}

// ─── 公开 API ─────────────────────────────────────────────────

/**
 * 按画像 resolve 本项目应下发的工具清单。
 * POST /resolve/tools → { tools: string[] }
 */
export async function resolveTools(
  orgId: string,
  feature?: ScopeProfileLike,
  apiBaseOverride?: string,
): Promise<string[]> {
  const body: Record<string, unknown> = { orgId };
  if (feature !== undefined) {
    body.projectFeature = feature;
  }
  const res = await apiPost<{ tools: string[] }>('/resolve/tools', body, apiBaseOverride);
  return res.tools;
}

/**
 * 按租户 + 画像 resolve 规则清单与变更集。
 * POST /resolve/rules → { rules: [...], changed: [...] }
 */
export async function resolveRules(
  orgId: string,
  feature?: ScopeProfileLike,
  currentVersions?: Record<string, string>,
  apiBaseOverride?: string,
): Promise<ResolveRulesResponse> {
  const body: Record<string, unknown> = { orgId };
  if (feature !== undefined) {
    body.projectFeature = feature;
  }
  if (currentVersions !== undefined) {
    body.currentVersions = currentVersions;
  }
  return apiPost<ResolveRulesResponse>('/resolve/rules', body, apiBaseOverride);
}

/**
 * 注册项目画像快照到云端（T0）。
 * PUT /orgs/:orgId/projects/:projectId/features → { ok, projectId, orgId }
 */
export async function registerProjectFeatures(
  orgId: string,
  userId: string,
  projectId: string,
  feature: ScopeProfileLike,
  apiBaseOverride?: string,
): Promise<void> {
  await apiPut<{ ok: true; projectId: string; orgId: string }>(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/features`,
    {
      userId,
      framework: feature.framework,
      language: feature.language,
      features: feature.features ?? [],
    },
    apiBaseOverride,
  );
}

/**
 * 健康探活（best-effort，失败返回 false）。
 * GET /resolve/health → { ok: true }
 */
export async function health(apiBaseOverride?: string): Promise<boolean> {
  try {
    const res = await apiGet<{ ok: true }>('/resolve/health', apiBaseOverride);
    return res.ok === true;
  } catch {
    return false;
  }
}
