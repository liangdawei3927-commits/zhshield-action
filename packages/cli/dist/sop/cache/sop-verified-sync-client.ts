import type { SignedSopPackage, SopRule } from '../_meta/sop-types';
import { SopSyncClient, type ApiTokenProvider } from './sop-sync-client';
import type { SopFetchResult } from './sop-sync-client';
import { CompressionFormat, type SopCompressor } from './sop-compressor';

/**
 * VerifiedSopSyncClient — 带验签拦截的云端同步客户端
 *
 * 在 SopSyncClient 之上为全量下载增加验签关卡：
 * - 响应为裸规则数组（旧版服务端）→ 原样放行（向后兼容）
 * - 响应为签名包 → 先验签，通过才返回包内规则；失败归 `signature_rejected`
 *
 * 归因口径：验签失败是**安全事件**，绝不能与网络故障混为一谈
 * （原实现一律返回 null，被拒收的投毒包在日志里表现为"网络错误"，无人告警）。
 */
export class VerifiedSopSyncClient extends SopSyncClient {
  private readonly baseUrl: string;

  constructor(
    remoteBaseUrl: string,
    private readonly verifyPackage: (pkg: SignedSopPackage) => Promise<boolean>,
    compressor?: SopCompressor,
    apiToken?: ApiTokenProvider,
  ) {
    super(remoteBaseUrl, compressor, apiToken);
    this.baseUrl = remoteBaseUrl;
  }

  /**
   * 下载全量规则包并强制验签；验签不通过即拒收（防缓存投毒）
   */
  async fetchFull(version: string): Promise<SopFetchResult<SopRule[]>> {
    const url = `${this.baseUrl}/full/${version}`;
    const res = await this.request(url, this.buildHeaders(), SopSyncClient.TIMEOUT_FULL_MS);
    if (!res.ok) return res;

    const body = await this.readBody(url, '读取压缩响应体', () => res.data.arrayBuffer());
    if (!body.ok) return body;

    const parsed = await this.decodeCompressed<unknown>(body.data, CompressionFormat.Brotli, url);
    if (!parsed.ok) return parsed;

    return this.verifyParsedPayload(parsed.data, url);
  }

  /**
   * 校验解析结果：裸规则数组直接放行，签名包验签通过才返回包内规则。
   * 两者都不是 ⇒ 协议不匹配（decode_error）；验签不过 ⇒ signature_rejected。
   */
  private async verifyParsedPayload(
    parsed: unknown,
    url: string,
  ): Promise<SopFetchResult<SopRule[]>> {
    if (Array.isArray(parsed)) return { ok: true, data: parsed as SopRule[] };
    if (!isSignedSopPackage(parsed)) {
      return {
        ok: false,
        failure: {
          kind: 'decode_error',
          url,
          detail: '响应既非规则数组也非签名包，拒绝解析（协议不匹配）',
        },
      };
    }
    const pkg = revivePackageDates(parsed);
    const valid = await this.verifyPackage(pkg);
    if (!valid) {
      return {
        ok: false,
        failure: {
          kind: 'signature_rejected',
          url,
          detail: `全量包验签未通过，已拒收（防缓存投毒；alg=${String(pkg.alg ?? 'unknown')}）`,
        },
      };
    }
    return { ok: true, data: pkg.rules };
  }
}

function isSignedSopPackage(value: unknown): value is SignedSopPackage {
  if (!value || typeof value !== 'object') return false;
  const pkg = value as Partial<SignedSopPackage>;
  return (
    typeof pkg.signature === 'string' && typeof pkg.hash === 'string' && Array.isArray(pkg.rules)
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
