import type { SopVersion, SopDiff, SopRule } from '../_meta/sop-types';
import { SopCompressor, CompressionFormat } from './sop-compressor';

/**
 * SopSyncClient — 云端同步客户端（文档 7.4 节）
 *
 * 负责与远程 API 通信：检查版本、下载增量 diff、下载全量规则包。
 */
export class SopSyncClient {
  protected readonly compressor: SopCompressor;

  constructor(
    private readonly remoteBaseUrl: string,
    compressor?: SopCompressor,
  ) {
    this.compressor = compressor ?? new SopCompressor();
  }

  /**
   * 检查云端版本 — GET /api/sop/version
   */
  async checkRemoteVersion(): Promise<SopVersion | null> {
    try {
      const url = `${this.remoteBaseUrl}/version`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return (await res.json()) as SopVersion;
    } catch {
      return null;
    }
  }

  /**
   * 下载增量 diff — GET /api/sop/diff?from={fromVersion}&to={toVersion}
   */
  async fetchDiff(fromVersion: string, toVersion: string): Promise<SopDiff | null> {
    try {
      const url = `${this.remoteBaseUrl}/diff?from=${fromVersion}&to=${toVersion}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return null;

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/octet-stream') || contentType.includes('cbor')) {
        const compressed = await res.arrayBuffer();
        const decompressed = await this.compressor.decompress(
          new Uint8Array(compressed),
          CompressionFormat.Gzip,
        );
        return JSON.parse(new TextDecoder().decode(decompressed)) as SopDiff;
      }

      return (await res.json()) as SopDiff;
    } catch {
      return null;
    }
  }

  /**
   * 下载全量规则包 — GET /api/sop/full/{version}
   * 返回解压后的规则列表，失败返回 null
   */
  async fetchFull(version: string): Promise<SopRule[] | null> {
    try {
      const fullUrl = `${this.remoteBaseUrl}/full/${version}`;
      const res = await fetch(fullUrl);
      if (!res.ok) return null;

      const compressed = await res.arrayBuffer();
      const decompressed = await this.compressor.decompress(
        new Uint8Array(compressed),
        CompressionFormat.Brotli,
      );
      return JSON.parse(new TextDecoder().decode(decompressed)) as SopRule[];
    } catch {
      return null;
    }
  }
}
