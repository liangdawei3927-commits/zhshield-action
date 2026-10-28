import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SopSyncCoordinator } from '../sop/cache/sop-sync-coordinator';
import { SopRegistry } from '../sop/_meta/sop-registry';
import type { SopFetchFailure, SopFetchResult } from '../sop/cache/sop-sync-client';
import type { SopRule, SopVersion, SopDiff } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

/**
 * 同步失败归因回归集。
 *
 * 原实现 `SopSyncClient` 三个方法一律 `catch { return null }`，`SopSyncCoordinator`
 * 再把所有失败压成 `network_error` ⇒「令牌过期」「云脑 5xx」「brotli 包损坏」
 * 「验签被拒」在日志、面板、重试策略里完全同形。本集锁住「每种失败都能被区分」，
 * 以及「降级路径上两条失败原因都不丢」。
 */

const REMOTE: SopVersion = {
  version: '2.0.0',
  knowledge: 'k',
  experience: 'e',
  malware: 'm',
  publishedAt: new Date('2026-10-01T00:00:00Z'),
  hash: 'sha256-x',
  size: 100,
};

const DIFF: SopDiff = {
  version: '2.0.0',
  fromVersion: '0.0.0',
  compatibility: '1.0.0',
  added: [makeRule({ id: 'new.rule' })],
  removed: [],
  modified: [],
  unchanged: [],
  metadata: { totalRules: 1, diffSize: 10, hash: '' },
};

function okResult<T>(data: T): SopFetchResult<T> {
  return { ok: true, data };
}

function failResult(
  kind: SopFetchFailure['kind'],
  url: string,
  detail: string,
  status?: number,
): SopFetchResult<never> {
  const failure: SopFetchFailure = { kind, url, detail };
  if (status !== undefined) failure.status = status;
  return { ok: false, failure };
}

interface StubOptions {
  version?: SopFetchResult<SopVersion>;
  diff?: SopFetchResult<SopDiff>;
  full?: SopFetchResult<SopRule[]>;
  online?: boolean;
  /** 模拟写库失败（SqliteStore.persist 抛错） */
  persistThrows?: boolean;
  /** 本地已存的版本号（versionStore.load 的返回值） */
  localVersion?: SopVersion;
}

/** 构造只关心「失败归因」的最小协调器 */
function makeCoordinator(opts: StubOptions = {}) {
  const registry = new SopRegistry();
  const recordedFailures: string[] = [];

  const coordinator = new SopSyncCoordinator({
    registry,
    clientVersion: '1.0.0',
    sqliteStore: {
      loadAll: () => [],
      persist: () => {
        if (opts.persistThrows) throw new Error('disk full');
      },
    } as never,
    versionStore: {
      load: async () => opts.localVersion ?? null,
      loadSyncState: async () => null,
      save: async () => {},
      saveSyncState: async () => {},
      logSync: async () => {},
    } as never,
    syncClient: {
      checkRemoteVersion: async () =>
        opts.version ?? failResult('network_error', '/version', 'stub 未配置'),
      fetchDiff: async () => opts.diff ?? failResult('http_error', '/diff', 'stub 未配置', 404),
      fetchFull: async () => opts.full ?? failResult('http_error', '/full', 'stub 未配置', 404),
    } as never,
    scheduler: {
      hydrate: () => {},
      recordSync: () => {},
      recordSyncFailure: (reason: string) => {
        recordedFailures.push(reason);
      },
      getState: () => ({}),
      isOnline: opts.online ?? true,
    } as never,
  });

  return { coordinator, registry, recordedFailures };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SopSyncCoordinator — 失败归因', () => {
  it('401 归 auth_error：重试无意义，须改令牌（不得混进 network_error）', async () => {
    const { coordinator, recordedFailures } = makeCoordinator({
      version: failResult('http_error', '/version', 'HTTP 401 Unauthorized', 401),
    });

    const result = await coordinator.syncFromCloud();

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('auth_error');
    expect(result.detail).toContain('401');
    expect(recordedFailures).toEqual(['auth_error']);
  });

  it('403 同样归 auth_error', async () => {
    const { coordinator } = makeCoordinator({
      version: failResult('http_error', '/version', 'HTTP 403 Forbidden', 403),
    });
    expect((await coordinator.syncFromCloud()).reason).toBe('auth_error');
  });

  it('5xx 归 http_error：与鉴权失败区分开（这类才值得重试）', async () => {
    const { coordinator } = makeCoordinator({
      version: failResult('http_error', '/version', 'HTTP 503 Service Unavailable', 503),
    });

    const result = await coordinator.syncFromCloud();

    expect(result.reason).toBe('http_error');
    expect(result.detail).toContain('503');
  });

  it('网络层失败归 network_error', async () => {
    const { coordinator } = makeCoordinator({
      version: failResult('network_error', '/version', '10s 上限内请求失败: ECONNREFUSED'),
    });
    expect((await coordinator.syncFromCloud()).reason).toBe('network_error');
  });

  it('响应解码失败归 decode_error（云端返回错误页 / 压缩包损坏）', async () => {
    const { coordinator } = makeCoordinator({
      version: failResult('decode_error', '/version', 'JSON 解析失败: Unexpected token <'),
    });

    const result = await coordinator.syncFromCloud();

    expect(result.reason).toBe('decode_error');
    expect(result.detail).toContain('JSON');
  });

  it('离线不发起请求，且原因与「云端无更新」可区分', async () => {
    const { coordinator } = makeCoordinator({ online: false, version: okResult(REMOTE) });

    const result = await coordinator.syncFromCloud();

    expect(result.reason).toBe('network_error');
    expect(result.detail).toContain('离线');
    // 关键：离线绝不能表现为 already_latest，否则面板会把"没联网"显示成"规则最新"
    expect(result.reason).not.toBe('already_latest');
  });

  it('增量失败但全量成功 → 仍算更新成功', async () => {
    const { coordinator, registry } = makeCoordinator({
      version: okResult(REMOTE),
      diff: failResult('http_error', '/diff', 'HTTP 404 Not Found', 404),
      full: okResult([makeRule({ id: 'full.rule' })]),
    });

    const result = await coordinator.syncFromCloud();

    expect(result.updated).toBe(true);
    expect(registry.get('full.rule')).toBeDefined();
  });

  it('增量与全量都失败 → detail 同时保留两条原因（根因不被末环掩盖）', async () => {
    const { coordinator } = makeCoordinator({
      version: okResult(REMOTE),
      diff: failResult('http_error', '/diff', 'HTTP 500 Internal Server Error', 500),
      full: failResult('http_error', '/full', 'HTTP 502 Bad Gateway', 502),
    });

    const result = await coordinator.syncFromCloud();

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('http_error');
    // 全量侧的 502 是主因，但增量侧的 500 必须留在 detail 里
    expect(result.detail).toContain('502');
    expect(result.detail).toContain('增量同步失败');
    expect(result.detail).toContain('500');
  });

  it('数据取到了但落地失败归 apply_error（不是网络错误）', async () => {
    const { coordinator } = makeCoordinator({
      version: okResult(REMOTE),
      diff: failResult('http_error', '/diff', 'HTTP 404 Not Found', 404),
      full: okResult([makeRule({ id: 'full.rule' })]),
      persistThrows: true,
    });

    const result = await coordinator.syncFromCloud();

    expect(result.updated).toBe(false);
    expect(result.reason).toBe('apply_error');
    expect(result.detail).toContain('disk full');
  });

  it('验签拒绝归 signature_rejected：安全事件不得报成网络错误', async () => {
    const { coordinator } = makeCoordinator({
      version: okResult(REMOTE),
      diff: failResult('http_error', '/diff', 'HTTP 404 Not Found', 404),
      full: failResult('signature_rejected', '/full', '全量包验签未通过，已拒收（防缓存投毒）'),
    });

    const result = await coordinator.syncFromCloud();

    expect(result.reason).toBe('signature_rejected');
    // 告警日志必须带上细节，否则值班的人只看得到 "同步未成功"
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('验签');
  });

  it('版本全新的路径仍返回 already_latest 且不记失败', async () => {
    const { coordinator, recordedFailures } = makeCoordinator({
      version: okResult(REMOTE),
      localVersion: REMOTE,
    });
    await coordinator.initialize();

    const result = await coordinator.syncFromCloud();

    expect(result.reason).toBe('already_latest');
    expect(recordedFailures).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
