import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readOrCreateUserId, getOrCreateDefaultOrg } from '../sop/sync/machine-identity';

const USER_ID_FILE = path.join(os.homedir(), '.zhshield', 'user-id');
const ORG_ID_FILE = path.join(os.homedir(), '.zhshield', 'default-org-id');

describe('readOrCreateUserId', () => {
  it('returns a UUID v4 string', () => {
    const userId = readOrCreateUserId();
    expect(userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('returns stable value across calls', () => {
    const first = readOrCreateUserId();
    const second = readOrCreateUserId();
    expect(first).toBe(second);
  });

  it('matches the file on disk', () => {
    const userId = readOrCreateUserId();
    const onDisk = fs.readFileSync(USER_ID_FILE, 'utf-8').trim();
    expect(userId).toBe(onDisk);
  });
});

describe('getOrCreateDefaultOrg', () => {
  beforeEach(() => {
    // 清除本地 orgId 缓存，保证每个用例独立
    try {
      fs.rmSync(ORG_ID_FILE);
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(ORG_ID_FILE);
    } catch {
      /* ignore */
    }
  });

  it('returns the server-provided orgId and persists it', async () => {
    const apiFn = vi.fn(async () => ({ orgId: 'server-org-abc' }));
    const result = await getOrCreateDefaultOrg(apiFn);
    expect(result).toEqual({ orgId: 'server-org-abc' });
    // 服务器返回的 orgId 被持久化，供后续复用
    expect(fs.readFileSync(ORG_ID_FILE, 'utf-8').trim()).toBe('server-org-abc');
    // apiFn 只调用一次（无缓存时创建）
    expect(apiFn).toHaveBeenCalledTimes(1);
    expect(apiFn).toHaveBeenCalledWith({
      name: 'zhshield-default',
      ownerId: readOrCreateUserId(),
    });
  });

  it('reuses the persisted orgId without calling the API again', async () => {
    fs.writeFileSync(ORG_ID_FILE, 'persisted-org-xyz', 'utf-8');
    const apiFn = vi.fn(async () => ({ orgId: 'should-not-create' }));
    const result = await getOrCreateDefaultOrg(apiFn);
    expect(result).toEqual({ orgId: 'persisted-org-xyz' });
    expect(apiFn).not.toHaveBeenCalled();
  });

  it('returns null when the API call fails (offline)', async () => {
    const apiFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await getOrCreateDefaultOrg(apiFn);
    expect(result).toBeNull();
    // 失败不落缓存
    expect(fs.existsSync(ORG_ID_FILE)).toBe(false);
  });

  it('returns null when server returns empty orgId', async () => {
    const apiFn = vi.fn(async () => ({ orgId: '' }));
    const result = await getOrCreateDefaultOrg(apiFn);
    expect(result).toBeNull();
    expect(fs.existsSync(ORG_ID_FILE)).toBe(false);
  });

  it('returns null when the server credential is rejected', async () => {
    const apiFn = vi.fn(async () => {
      const err = new Error('Unauthorized');
      (err as Error & { status: number }).status = 401;
      throw err;
    });
    const result = await getOrCreateDefaultOrg(apiFn);
    expect(result).toBeNull();
  });
});
