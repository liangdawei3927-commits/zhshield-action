import type { SopVersion, SopDiff, SopRule } from '../_meta/sop-types';
import { SopCompressor, CompressionFormat } from './sop-compressor';

/** API 令牌：固定字符串或懒加载函数（每次请求时求值，兼容令牌文件轮换） */
export type ApiTokenProvider = string | (() => string);

/**
 * SopSyncClient — 云端同步客户端（文档 7.4 节）
 *
 * 负责与远程 API 通信：检查版本、下载增量 diff、下载全量规则包。
 */
export class SopSyncClient {
  protected readonly compressor: SopCompressor;
  private readonly apiToken?: ApiTokenProvider;

  constructor(
    private readonly remoteBaseUrl: string,
    compressor?: SopCompressor,
    apiToken?: ApiTokenProvider,
  ) {
    this.compressor = compressor ?? new SopCompressor();
    this.apiToken = apiToken;
  }

  /** 组装请求头；注入 x-api-token 供本地后端 LocalOnlyGuard 鉴权（与工具规则路径一致） */
  protected buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.apiToken !== undefined) {
      const token = typeof this.apiToken === 'function' ? this.apiToken() : this.apiToken;
      if (token) headers['x-api-token'] = token;
    }
    return headers;
  }

  /**
   * 检查云端版本 — GET /api/sop/version
   */
  async checkRemoteVersion(): Promise<SopVersion | null> {
    try {
      const url = `${this.remoteBaseUrl}/version`;
      const res = await fetch(url, {
        headers: this.buildHeaders({ Accept: 'application/json' }),
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
      const res = await fetch(url, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
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
      const res = await fetch(fullUrl, { headers: this.buildHeaders() });
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
