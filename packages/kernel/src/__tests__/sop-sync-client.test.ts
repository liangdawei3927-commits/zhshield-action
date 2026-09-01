import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SopSyncClient } from '../sop/cache/sop-sync-client';
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
    headers,
    json: async () => body as never,
    arrayBuffer: async () => body as ArrayBuffer,
  } as unknown as Response;
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
      const result = await client.checkRemoteVersion();
      expect(result).not.toBeNull();
      expect(result?.version).toBe('1.2026.08.01.001');
      // 应请求 /version 端点
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/version`,
        expect.objectContaining({ headers: { Accept: 'application/json' } }),
      );
    });

    it('HTTP 非 2xx 应返回 null', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(null, { ok: false, status: 500 }));
      expect(await client.checkRemoteVersion()).toBeNull();
    });

    it('fetch 抛错应返回 null（网络故障容错）', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      expect(await client.checkRemoteVersion()).toBeNull();
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
      const result = await client.fetchDiff('1.0.0', '2.0.0');
      expect(result).not.toBeNull();
      expect(result?.version).toBe('2.0.0');
      expect(result?.added.length).toBe(1);
      expect(result?.removed).toContain('old-rule');
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
      const result = await client.fetchDiff('1.0.0', '2.0.0');
      expect(result).not.toBeNull();
      expect(result?.version).toBe('2.0.0');
      expect(result?.added[0].id).toBe('new-rule');
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
      const result = await client.fetchDiff('1.0.0', '2.0.0');
      expect(result).not.toBeNull();
      expect(result?.version).toBe('2.0.0');
    });

    it('HTTP 错误应返回 null', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(null, { ok: false, status: 404 }));
      expect(await client.fetchDiff('1.0.0', '2.0.0')).toBeNull();
    });

    it('fetch 抛错应返回 null', async () => {
      fetchMock.mockRejectedValueOnce(new Error('timeout'));
      expect(await client.fetchDiff('1.0.0', '2.0.0')).toBeNull();
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
      const result = await client.fetchFull('3.0.0');
      expect(result).not.toBeNull();
      expect(result?.length).toBe(2);
      expect(result?.[0].id).toBe('r-1');
      // URL 应包含版本路径
      expect(fetchMock).toHaveBeenCalledWith(`${baseUrl}/full/3.0.0`);
    });

    it('HTTP 错误应返回 null', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(null, { ok: false, status: 500 }));
      expect(await client.fetchFull('3.0.0')).toBeNull();
    });

    it('fetch 抛错应返回 null', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network'));
      expect(await client.fetchFull('3.0.0')).toBeNull();
    });

    it('解压失败应返回 null（容错）', async () => {
      // 提供非法压缩数据 → decompress 抛错 → catch 返回 null
      fetchMock.mockResolvedValueOnce(makeResponse(new ArrayBuffer(8)));
      expect(await client.fetchFull('3.0.0')).toBeNull();
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
});
