/**
 * 机器身份 + 默认组织引导（machine-identity.ts）
 *
 * 为客户端提供稳定的 userId 和默认 orgId：
 * - readOrCreateUserId(): 从 ~/.zhshield/user-id 读取或创建稳定机器 UUID
 * - getOrCreateDefaultOrg(): 首次创建默认组织并持久化服务器返回的真实 orgId，
 *   后续运行复用本地已存的 orgId（避免每次运行重复建组织）
 *
 * 所有 I/O 均同步写入磁盘（Electron MAIN 进程），失败降级为内存态。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// ─── 类型 ────────────────────────────────────────────────────

export interface DefaultOrgResult {
  /** 服务器真实返回的 orgId（已持久化，跨运行稳定） */
  readonly orgId: string;
}

export interface CreateOrgResponse {
  orgId: string;
}

/**
 * 创建组织的 API 函数签名。
 * 服务器 POST /orgs 返回 { orgId }，orgId 由服务器生成（randomUUID），
 * 客户端必须使用服务器返回的值，而非本地臆造。
 */
export type CreateOrgFn = (body: {
  name: string;
  ownerId: string;
}) => Promise<CreateOrgResponse>;

// ─── 路径 ─────────────────────────────────────────────────────

const ZHSHIELD_DIR = path.join(os.homedir(), '.zhshield');
const USER_ID_FILE = path.join(ZHSHIELD_DIR, 'user-id');
const DEFAULT_ORG_ID_FILE = path.join(ZHSHIELD_DIR, 'default-org-id');

// ─── userId ───────────────────────────────────────────────────

/**
 * 读取或创建稳定的机器 userId。
 * 文件 ~/.zhshield/user-id 不存在时生成 crypto.randomUUID() 并写入。
 * 返回值始终为非空字符串。
 */
export function readOrCreateUserId(): string {
  if (!fs.existsSync(ZHSHIELD_DIR)) {
    fs.mkdirSync(ZHSHIELD_DIR, { recursive: true });
  }

  if (fs.existsSync(USER_ID_FILE)) {
    const stored = fs.readFileSync(USER_ID_FILE, 'utf-8').trim();
    if (stored.length > 0) return stored;
  }

  const userId = crypto.randomUUID();
  fs.writeFileSync(USER_ID_FILE, userId, { encoding: 'utf-8' });
  return userId;
}

// ─── 默认组织（持久化服务器真实 orgId）─────────────────────

/**
 * 读取本地已存的默认 orgId；不存在返回 null。
 */
export function readCachedDefaultOrgId(): string | null {
  try {
    if (fs.existsSync(DEFAULT_ORG_ID_FILE)) {
      const stored = fs.readFileSync(DEFAULT_ORG_ID_FILE, 'utf-8').trim();
      if (stored.length > 0) return stored;
    }
  } catch {
    // 读取失败视为无缓存
  }
  return null;
}

/**
 * 获取或创建默认组织。
 *
 * 正确性关键：服务器 POST /orgs 生成 randomUUID 的 orgId（客户端不可臆造）。
 * 因此：
 * 1. 优先读取本地已持久化的 orgId（~/.zhshield/default-org-id），跨运行稳定；
 * 2. 无缓存 + 有网 → 调 apiFn 创建组织，把服务器返回的 orgId 持久化后返回；
 * 3. 创建失败（网络不可达等）→ 返回 null（下游 resolve 会降级为本地默认行为）。
 *
 * 不再使用"确定性推导 orgId"——那永远匹配不上服务器真实组织，
 * 会导致 T0 画像注册 assertMember 失败、T1 resolve 拿不到租户规则。
 */
export async function getOrCreateDefaultOrg(
  apiFn: CreateOrgFn,
): Promise<DefaultOrgResult | null> {
  // 1. 优先复用已持久化的 orgId
  const cached = readCachedDefaultOrgId();
  if (cached) {
    return { orgId: cached };
  }

  // 2. 无缓存时创建组织
  const userId = readOrCreateUserId();
  try {
    const { orgId } = await apiFn({ name: 'zhshield-default', ownerId: userId });
    if (!orgId || orgId.trim() === '') {
      return null;
    }
    persistDefaultOrgId(orgId);
    return { orgId };
  } catch {
    // 网络不可达 / 服务端异常 → 无法获取真实 orgId，返回 null 让下游降级
    return null;
  }
}

// ─── helpers ──────────────────────────────────────────────────

function persistDefaultOrgId(orgId: string): void {
  try {
    if (!fs.existsSync(ZHSHIELD_DIR)) {
      fs.mkdirSync(ZHSHIELD_DIR, { recursive: true });
    }
    fs.writeFileSync(DEFAULT_ORG_ID_FILE, orgId, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // 持久化失败仅影响下次是否复用，不阻断本次
  }
}
