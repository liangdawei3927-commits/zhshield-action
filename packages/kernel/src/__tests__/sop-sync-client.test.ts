import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SopSyncClient,
  type SopFetchResult,
  type SopFetchFailure,
} from '../sop/cache/sop-sync-client';
import { SopCompressor, CompressionFormat } from '../sop/cache/sop-compressor';
import type { SopVersion, SopDiff, SopRule } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

/** 构造一个 mock Response */
function makeResponse(
  body: unknown,
  opts: { ok?: boolean; status?: number; contentType?: string } = {},
): Response {
  const ok = opts.ok ?? true;
  const status = opts.status ?? (ok ? 200 : 500);
  const headers = new Headers();
  if (opts.contentType) headers.set('content-type', opts.contentType);
  return {
    ok,
    status,
    statusText: '',
    headers,
    json: async () => body as never,
    arrayBuffer: async () => body as ArrayBuffer,
  } as unknown as Response;
}

/** 断言成功并取出数据；失败时把归因打出来，避免"期望成功"这种无信息量的报错 */
function expectOk<T>(result: SopFetchResult<T>): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败: ${result.failure.kind} — ${result.failure.detail}`);
  }
  return result.data;
}

/** 断言失败并取出归因 */
function expectFail<T>(result: SopFetchResult<T>): SopFetchFailure {
  if (result.ok) throw new Error('期望失败，实际成功');
  return result.failure;
}

/** 构造指定 name 的异常（AbortSignal.timeout 抛的是 TimeoutError） */
function errorNamed(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('SopSyncClient', () => {
  const baseUrl = 'https://sop.example.com/api/sop';
  let client: SopSyncClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new SopSyncClient(baseUrl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── checkRemoteVersion ──────────────────────────
  describe('checkRemoteVersion', () => {
    it('成功应返回 SopVersion', async () => {
      const version: SopVersion = {
        version: '1.2026.08.01.001',
        knowledge: 'k-1',
        experience: 'e-1',
        malware: 'm-1',
        publishedAt: new Date('2026-08-01T00:00:00Z'),
        hash: 'sha256-abc',
        size: 1024,
      };
      fetchMock.mockResolvedValueOnce(makeResponse(version));
      const data = expectOk(await client.checkRemoteVersion());
      expect(data.version).toBe('1.2026.08.01.001');
      // 应请求 /version 端点
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/version`,
        expect.objectContaining({ headers: { Accept: 'application/json' } }),
      );
    });

    it('HTTP 非 2xx 应归 http_error 并带状态码', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(null, { ok: false, status: 500 }));
      const failure = expectFail(await client.checkRemoteVersion());
      expect(failure.kind).toBe('http_error');
      expect(failure.status).toBe(500);
    });

    it('fetch 抛错应归 network_error（网络故障容错）', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      const failure = expectFail(await client.checkRemoteVersion());
      expect(failure.kind).toBe('network_error');
      expect(failure.detail).toContain('network down');
    });

    it('AbortSignal 超时抛 TimeoutError 应归 timeout（与网络层失败区分）', async () => {
      fetchMock.mockRejectedValueOnce(errorNamed('TimeoutError', 'The operation was aborted'));
      expect(expectFail(await client.checkRemoteVersion()).kind).toBe('timeout');
    });

    it('响应体不是合法 JSON 应归 decode_error（云端返回 HTML 错误页的典型表现）', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: '',
        headers: new Headers(),
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      } as unknown as Response);
      const failure = expectFail(await client.checkRemoteVersion());
      expect(failure.kind).toBe('decode_error');
      expect(failure.detail).toContain('JSON');
    });
  });

  // ─── fetchDiff ───────────────────────────────────
  describe('fetchDiff', () => {
    const sampleDiff: SopDiff = {
      version: '2.0.0',
      fromVersion: '1.0.0',
      compatibility: '2.0.0',
      added: [makeRule({ id: 'new-rule' })],
      removed: ['old-rule'],
      modified: [],
      unchanged: ['stable-rule'],
      metadata: { totalRules: 2, diffSize: 100, hash: 'h' },
    };

    it('JSON 响应应直接解析为 SopDiff', async () => {
      fetchMock.mockResolvedValueOnce(
        makeResponse(sampleDiff, { contentType: 'application/json' }),
      );
      const data = expectOk(await client.fetchDiff('1.0.0', '2.0.0'));
      expect(data.version).toBe('2.0.0');
      expect(data.added.length).toBe(1);
      expect(data.removed).toContain('old-rule');
      // URL 应包含 from/to 查询参数
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/diff?from=1.0.0&to=2.0.0`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('二进制压缩响应（octet-stream）应通过 gzip 解压', async () => {
      const compressor = new SopCompressor();
      const json = JSON.stringify(sampleDiff);
      const compressed = await compressor.compress(
        Buffer.from(json, 'utf-8'),
        CompressionFormat.Gzip,
      );
      const buffer = compressed.buffer.slice(
        compressed.byteOffset,
        compressed.byteOffset + compressed.byteLength,
      );

      fetchMock.mockResolvedValueOnce(
        makeResponse(buffer, { contentType: 'application/octet-stream' }),
      );
      const data = expectOk(await client.fetchDiff('1.0.0', '2.0.0'));
      expect(data.version).toBe('2.0.0');
      expect(data.added[0].id).toBe('new-rule');
    });

    it('cbor content-type 也应走解压分支', async () => {
      const compressor = new SopCompressor();
      const json = JSON.stringify(sampleDiff);
      const compressed = await compressor.compress(
        Buffer.from(json, 'utf-8'),
        CompressionFormat.Gzip,
      );
      const buffer = compressed.buffer.slice(
        compressed.byteOffset,
        compressed.byteOffset + compressed.byteLength,
      );

      fetchMock.mockResolvedValueOnce(makeResponse(buffer, { contentType: 'application/cbor' }));
      expect(expectOk(await client.fetchDiff('1.0.0', '2.0.0')).version).toBe('2.0.0');
    });

    it('HTTP 404 应归 http_error（增量端点不存在 → 上层据此降级全量）', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(null, { ok: false, status: 404 }));
      const failure = expectFail(await client.fetchDiff('1.0.0', '2.0.0'));
      expect(failure.kind).toBe('http_error');
      expect(failure.status).toBe(404);
    });

    it('fetch 抛错应归 network_error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('timeout'));
      expect(expectFail(await client.fetchDiff('1.0.0', '2.0.0')).kind).toBe('network_error');
    });
  });

  // ─── fetchFull ───────────────────────────────────
  describe('fetchFull', () => {
    it('成功应返回解压后的规则数组（brotli）', async () => {
      const rules: SopRule[] = [makeRule({ id: 'r-1' }), makeRule({ id: 'r-2' })];
      const compressor = new SopCompressor();
      const json = JSON.stringify(rules);
      const compressed = await compressor.compress(
        Buffer.from(json, 'utf-8'),
        CompressionFormat.Brotli,
      );
      const buffer = compressed.buffer.slice(
        compressed.byteOffset,
        compressed.byteOffset + compressed.byteLength,
      );

      fetchMock.mockResolvedValueOnce(makeResponse(buffer));
      const data = expectOk(await client.fetchFull('3.0.0'));
      expect(data.length).toBe(2);
      expect(data[0].id).toBe('r-1');
      // URL 应包含版本路径
      expect(fetchMock).toHaveBeenCalledWith(`${baseUrl}/full/3.0.0`, expect.any(Object));
    });

    it('HTTP 错误应归 http_error', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(null, { ok: false, status: 500 }));
      expect(expectFail(await client.fetchFull('3.0.0')).status).toBe(500);
    });

    it('fetch 抛错应归 network_error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network'));
      expect(expectFail(await client.fetchFull('3.0.0')).kind).toBe('network_error');
    });

    it('解压失败应归 decode_error（不是网络错误）', async () => {
      // 提供非法压缩数据 → decompress 抛错
      fetchMock.mockResolvedValueOnce(makeResponse(new ArrayBuffer(8)));
      const failure = expectFail(await client.fetchFull('3.0.0'));
      expect(failure.kind).toBe('decode_error');
      expect(failure.detail).toContain('解压');
    });

    it('全量下载须带超时信号（原实现无 signal 会无限挂起）', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(new ArrayBuffer(8)));
      await client.fetchFull('3.0.0');
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/full/3.0.0`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  // ─── 自定义 compressor 注入 ──────────────────────
  describe('自定义 compressor', () => {
    it('应支持注入自定义 compressor 实例', async () => {
      const customCompressor = new SopCompressor();
      const spy = vi.spyOn(customCompressor, 'decompress');
      const clientWithCustom = new SopSyncClient(baseUrl, customCompressor);

      const rules: SopRule[] = [makeRule({ id: 'r-1' })];
      const json = JSON.stringify(rules);
      const compressed = await customCompressor.compress(
        Buffer.from(json, 'utf-8'),
        CompressionFormat.Brotli,
      );
      const buffer = compressed.buffer.slice(
        compressed.byteOffset,
        compressed.byteOffset + compressed.byteLength,
      );

      fetchMock.mockResolvedValueOnce(makeResponse(buffer));
      await clientWithCustom.fetchFull('1.0.0');
      expect(spy).toHaveBeenCalled();
    });
  });

  // ─── API 令牌注入 ────────────────────────────────
  describe('API 令牌注入', () => {
    it('固定令牌：checkRemoteVersion 请求头应带 x-api-token', async () => {
      const version: SopVersion = { version: '1.0.0', knowledge: 'k', timestamp: new Date() };
      fetchMock.mockResolvedValueOnce(makeResponse(version));
      const authed = new SopSyncClient(baseUrl, undefined, 'tok-123');
      await authed.checkRemoteVersion();
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/version`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-api-token': 'tok-123' }),
        }),
      );
    });

    it('固定令牌：fetchDiff 请求头应带 x-api-token', async () => {
      const diff: SopDiff = { from: '1.0.0', to: '2.0.0', rules: [], removedRuleIds: [] };
      fetchMock.mockResolvedValueOnce(makeResponse(diff, { contentType: 'application/json' }));
      const authed = new SopSyncClient(baseUrl, undefined, 'tok-123');
      await authed.fetchDiff('1.0.0', '2.0.0');
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/diff?from=1.0.0&to=2.0.0`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-api-token': 'tok-123' }),
        }),
      );
    });

    it('懒加载令牌：每次请求时求值，支持令牌文件轮换', async () => {
      const version: SopVersion = { version: '1.0.0', knowledge: 'k', timestamp: new Date() };
      fetchMock.mockResolvedValue(makeResponse(version));
      const getToken = vi.fn().mockReturnValueOnce('tok-a').mockReturnValueOnce('tok-b');
      const authed = new SopSyncClient(baseUrl, undefined, getToken);

      await authed.checkRemoteVersion();
      await authed.checkRemoteVersion();
      expect(getToken).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        `${baseUrl}/version`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-api-token': 'tok-b' }),
        }),
      );
    });

    it('未配置令牌：不带 x-api-token 头（兼容无鉴权远端）', async () => {
      const version: SopVersion = { version: '1.0.0', knowledge: 'k', timestamp: new Date() };
      fetchMock.mockResolvedValueOnce(makeResponse(version));
      await client.checkRemoteVersion();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${baseUrl}/version`);
      expect((init.headers as Record<string, string>)['x-api-token']).toBeUndefined();
    });
  });
});
