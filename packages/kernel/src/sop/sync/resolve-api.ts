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
    languages: string[];
  }>;
  changed: string[];
}

/** 服务端 resolve 返回的单工具条目（toolId + 语言元数据） */
export interface ResolvedTool {
  toolId: string;
  languages: string[];
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

/**
 * DELETE 请求（用于注销类端点）。支持可选 body（鉴权字段，如注销需 body.userId）。
 * 与 apiGet 对称：携带 x-api-token + Accept，超时 10_000，withRetry 包裹，非 ok 抛 HttpError。
 */
async function apiDelete<T>(
  endpoint: string,
  body?: Record<string, unknown>,
  apiBaseOverride?: string,
): Promise<T> {
  const apiBase = resolveApiBase(apiBaseOverride);
  const token = readApiToken();

  const res = await withRetry(async () => {
    const r = await fetch(`${apiBase}${endpoint}`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'x-api-token': token,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new HttpError(r.status);
    return r;
  });

  return (await res.json()) as T;
}

// ─── 公开 API ─────────────────────────────────────────────────

/**
 * 按画像 resolve 本项目应下发的工具清单。
 * POST /resolve/tools → { tools: Array<{ toolId, languages }> }
 * languages 缺失时默认 []（向后兼容旧服务端）。
 */
export async function resolveTools(
  orgId: string,
  feature?: ScopeProfileLike,
  apiBaseOverride?: string,
): Promise<ResolvedTool[]> {
  const body: Record<string, unknown> = { orgId };
  if (feature !== undefined) {
    body.projectFeature = feature;
  }
  const res = await apiPost<{ tools?: Array<{ toolId: string; languages?: string[] }> }>(
    '/resolve/tools',
    body,
    apiBaseOverride,
  );
  return (res.tools ?? []).map((tool) => ({
    toolId: tool.toolId,
    languages: Array.isArray(tool.languages) ? tool.languages : [],
  }));
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
 * 注销 T0 画像快照（与 registerProjectFeatures 对称）。
 * DELETE /orgs/:orgId/projects/:projectId/features → { ok: true }
 * body 携带 userId（服务端 assertMember 鉴权契约，缺失 → 400）。
 */
export async function unregisterProjectFeatures(
  orgId: string,
  userId: string,
  projectId: string,
  apiBaseOverride?: string,
): Promise<void> {
  await apiDelete<{ ok: true }>(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/features`,
    { userId },
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
