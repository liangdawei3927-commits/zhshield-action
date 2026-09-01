import type { SignedSopPackage } from '../_meta/sop-types';
import { SopSigner } from '../security/sop-signer';

/**
 * SopSignatureVerifier — SOP 规则包签名校验器（从 SopCacheManager 拆出的独立职责）
 */
export class SopSignatureVerifier {
  constructor(
    private readonly publicKey?: string | (() => Promise<string | null>),
    private readonly strict = false,
  ) {}

  /**
   * 获取验签公钥：字符串原样返回，函数取解析结果，未配置返回 null
   */
  async getPublicKey(): Promise<string | null> {
    if (typeof this.publicKey === 'string') return this.publicKey;
    if (typeof this.publicKey === 'function') return this.publicKey();
    return null;
  }

  /**
   * 校验规则包签名（内部按 pkg.alg 分发 Ed25519/HMAC）：
   * - 未配置 publicKey → strict 时 fail-closed 拒绝，否则放行（向后兼容）
   * - 已配置但公钥解析失败 → fail-closed 拒绝
   * - 规则包路径使用缓存窗口（大值），新鲜度归缓存层 TTL
   */
  async verifySignature(pkg: SignedSopPackage): Promise<boolean> {
    if (this.publicKey === undefined) return this.strict ? false : true;
    const key = await this.getPublicKey();
    if (!key) return false;
    return SopSigner.verifyPackage(pkg, key, { windowMs: SopSigner.CACHE_WINDOW_MS }).valid;
  }
}
