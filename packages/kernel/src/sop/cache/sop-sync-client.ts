import type { SopVersion, SopDiff, SopRule, SignedSopPackage } from '../_meta/sop-types';
import { SopCompressor, CompressionFormat } from './sop-compressor';
import { SopSigner } from '../security/sop-signer';

/**
 * SopSyncClient — 云端同步客户端（文档 7.4 节）
 *
 * 负责与远程 API 通信：检查版本、下载增量 diff、下载全量规则包。
 * 全量包使用 Ed25519 签名校验（防篡改/防伪造），未配置公钥时拒绝接受（fail-closed）。
 */
export class SopSyncClient {
  private readonly compressor: SopCompressor;
  private readonly publicKey: string | (() => Promise<string | null>) | undefined;

  constructor(
    private readonly remoteBaseUrl: string,
    compressor?: SopCompressor,
    publicKey?: string | (() => Promise<string | null>),
  ) {
    this.compressor = compressor ?? new SopCompressor();
    this.publicKey = publicKey;
  }

  private async resolvePublicKey(): Promise<string | null> {
    if (typeof this.publicKey === 'function') {
      return this.publicKey();
    }
    return this.publicKey ?? null;
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
   * 服务端返回 brotli 压缩的 SignedSopPackage（Ed25519 签名）。
   * 客户端验签通过才返回规则列表；未配置公钥或验签失败一律返回 null（fail-closed）。
   */
  async fetchFull(version: string): Promise<SopRule[] | null> {
    try {
      const fullUrl = `${this.remoteBaseUrl}/full/${version}`;
      const res = await fetch(fullUrl);
      if (!res.ok) return null;

      const publicKey = await this.resolvePublicKey();
      if (!publicKey) {
        console.warn('[SopSyncClient] No public key configured — refusing unverified package');
        return null;
      }

      const raw = new Uint8Array(await res.arrayBuffer());
      // Node/undici fetch 会按 Content-Encoding: br 自动解压（raw 已是 JSON 文本）；
      // 未自动解压时 raw 是 brotli 二进制，JSON 解析失败后手动解压
      let pkg: SignedSopPackage;
      try {
        pkg = JSON.parse(new TextDecoder().decode(raw)) as SignedSopPackage;
      } catch {
        const decompressed = await this.compressor.decompress(raw, CompressionFormat.Brotli);
        pkg = JSON.parse(new TextDecoder().decode(decompressed)) as SignedSopPackage;
      }

      const verify = SopSigner.verifyPackageWithKey(pkg, publicKey);
      if (!verify.valid) {
        console.warn(`[SopSyncClient] Package verification failed: ${verify.reason}`);
        return null;
      }
      return pkg.rules;
    } catch {
      return null;
    }
  }
}
