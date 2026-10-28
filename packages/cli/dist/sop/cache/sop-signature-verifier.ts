import type { SignedSopPackage } from '../_meta/sop-types';
import { SopSigner } from '../security/sop-signer';

/**
 * SopSignatureVerifier — SOP 规则包签名校验器（从 SopCacheManager 拆出的独立职责）
 *
 * 口径（2026-10-29 统一）：**任何拿不到公钥的情况一律 fail-closed**。
 *
 * 原实现带一个 `strict` 开关，未配置公钥时走 `strict ? false : true` ——
 * 默认语义是**放行任意规则包**（fail-open 后门）。而全仓无任何调用方传
 * `strict: true`，这个参数既是死参数，又让「忘了传公钥」的误用静默变成
 * 「不验签」。桌面端另一条链路（`electron/ipc/sync.ts` 的 `no_public_key`）对
 * 同一件事的处理是拒绝 —— 两条链路口径相反，正是这个参数造成的。
 *
 * 现在：无公钥 ⇒ 拒绝 + 一次性告警。要关验签必须显式不构造本类
 * （`SopCacheManager` 不传 publicKey 时走裸 SopSyncClient，且另有明确告警）。
 */
export class SopSignatureVerifier {
  /** 「未配置公钥」告警只打一次：同步是周期任务，每轮刷一行会把日志淹掉 */
  private warnedNoKey = false;

  constructor(private readonly publicKey?: string | (() => Promise<string | null>)) {}

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
   * - 未配置公钥 / 公钥解析失败 → fail-closed 拒绝（并告警一次）
   * - 规则包路径使用缓存窗口（大值），新鲜度归缓存层 TTL
   */
  async verifySignature(pkg: SignedSopPackage): Promise<boolean> {
    const key = await this.getPublicKey();
    if (!key) {
      this.warnNoKeyOnce();
      return false;
    }
    return SopSigner.verifyPackage(pkg, key, { windowMs: SopSigner.CACHE_WINDOW_MS }).valid;
  }

  private warnNoKeyOnce(): void {
    if (this.warnedNoKey) return;
    this.warnedNoKey = true;
    console.warn(
      '[SopSignatureVerifier] 未配置验签公钥：规则包一律拒收（fail-closed）。' +
        '请设置 ZH_SOP_PUBLIC_KEY 环境变量，或确保服务端 /api/sop/public-key 可达。',
    );
  }
}
