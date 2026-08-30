import type { SignedSopPackage, SopRule } from '../_meta/sop-types';
import { SopSyncClient } from './sop-sync-client';
import { CompressionFormat, type SopCompressor } from './sop-compressor';

/**
 * VerifiedSopSyncClient — 带验签拦截的云端同步客户端
 *
 * 在 SopSyncClient 之上为全量下载增加验签关卡：
 * - 响应为裸规则数组（旧版服务端）→ 原样放行（向后兼容）
 * - 响应为签名包 → 先验签，通过才返回包内规则；失败返回 null（拒绝缓存投毒数据）
 */
export class VerifiedSopSyncClient extends SopSyncClient {
  private readonly baseUrl: string;

  constructor(
    remoteBaseUrl: string,
    private readonly verifyPackage: (pkg: SignedSopPackage) => Promise<boolean>,
    compressor?: SopCompressor,
  ) {
    super(remoteBaseUrl, compressor);
    this.baseUrl = remoteBaseUrl;
  }

  /**
   * 下载全量规则包并强制验签，失败返回 null
   */
  async fetchFull(version: string): Promise<SopRule[] | null> {
    try {
      const parsed = await this.fetchAndParsePayload(version);
      if (parsed === null) return null;
      return await this.verifyParsedPayload(parsed);
    } catch {
      return null;
    }
  }

  /** 下载并解压全量包，解析为 JSON；网络/解压失败返回 null */
  private async fetchAndParsePayload(version: string): Promise<unknown | null> {
    const res = await fetch(`${this.baseUrl}/full/${version}`);
    if (!res.ok) return null;
    const compressed = await res.arrayBuffer();
    const decompressed = await this.compressor.decompress(
      new Uint8Array(compressed),
      CompressionFormat.Brotli,
    );
    return JSON.parse(new TextDecoder().decode(decompressed));
  }

  /** 校验解析结果：裸规则数组直接放行，签名包验签通过才返回包内规则 */
  private async verifyParsedPayload(parsed: unknown): Promise<SopRule[] | null> {
    if (Array.isArray(parsed)) return parsed as SopRule[];
    if (!isSignedSopPackage(parsed)) return null;
    const pkg = revivePackageDates(parsed);
    const valid = await this.verifyPackage(pkg);
    return valid ? pkg.rules : null;
  }
}

function isSignedSopPackage(value: unknown): value is SignedSopPackage {
  if (!value || typeof value !== 'object') return false;
  const pkg = value as Partial<SignedSopPackage>;
  return (
    typeof pkg.signature === 'string' &&
    typeof pkg.hash === 'string' &&
    Array.isArray(pkg.rules)
  );
}

/** JSON 传输会把 Date 序列化为字符串：验签前还原 timestamp 与规则日期字段，
 *  还原后再序列化的哈希与签名与签名端一致（toISOString 可逆） */
function revivePackageDates(pkg: SignedSopPackage): SignedSopPackage {
  return {
    ...pkg,
    timestamp: new Date(pkg.timestamp),
    rules: pkg.rules.map(reviveRuleDates),
  };
}

function reviveRuleDates(rule: SopRule): SopRule {
  return {
    ...rule,
    lastUsedAt: rule.lastUsedAt ? new Date(rule.lastUsedAt) : undefined,
    createdAt: new Date(rule.createdAt),
    updatedAt: new Date(rule.updatedAt),
  };
}
