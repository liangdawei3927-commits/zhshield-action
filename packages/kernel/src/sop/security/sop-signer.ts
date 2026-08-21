import * as crypto from 'node:crypto';
import type { SopRule, SignedSopPackage } from '../_meta/sop-types';

export interface SignRequestParams {
  method: string;
  path: string;
  body: unknown;
  secretKey: string;
  nonce: string;
  timestamp?: string;
}

export interface VerifyRequestParams {
  method: string;
  path: string;
  body: unknown;
  secretKey: string;
  nonce: string;
  signature: string;
  timestamp: string;
}

/**
 * SopSigner — 规则包签名与验证（文档 11.3 节）
 *
 * 保护规则的机密性和完整性：
 * - 传输安全：HTTPS + TLS 1.3
 * - 规则包签名：HMAC-SHA256
 * - 防重放攻击：时间戳 + Nonce
 * - 本地存储加密：AES-256-GCM
 */
export class SopSigner {
  /** 时间戳有效窗口（5 分钟） */
  private static readonly TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

  // ─── 规则包签名 ────────────────────────────────────────────

  /**
   * 签名规则包（云端签名）
   * 文档 11.3 节：
   * 1. 规则按 ID 排序后序列化
   * 2. 计算 SHA-256 哈希
   * 3. HMAC-SHA256 签名
   */
  static signPackage(rules: SopRule[], secretKey: string, version?: string): SignedSopPackage {
    // 按 ID 排序确保一致性
    const sorted = rules.toSorted((a, b) => a.id.localeCompare(b.id));
    const content = JSON.stringify(sorted);

    // 计算内容哈希
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // 生成签名（HMAC-SHA256）
    const timestamp = new Date();
    const signature = SopSigner.hmacSign(secretKey, `${hash}:${timestamp.toISOString()}`);

    return {
      version: version ?? '0.0.0',
      rules: sorted,
      signature,
      hash,
      timestamp,
    };
  }

  /**
   * 验证签名（桌面端验证）
   * 文档 11.3 节：
   * 1. 验证时间戳（防止重放攻击）
   * 2. 验证哈希（防止篡改）
   * 3. 验证签名（防止伪造）
   */
  static verifyPackage(pkg: SignedSopPackage, secretKey: string): VerifyResult {
    const tsResult = SopSigner.verifyTimestamp(pkg.timestamp);
    if (!tsResult.valid) return tsResult;
    const sorted = pkg.rules.toSorted((a, b) => a.id.localeCompare(b.id));
    const content = JSON.stringify(sorted);
    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    if (pkg.hash !== expectedHash) {
      return { valid: false, reason: 'hash_mismatch' };
    }
    const expectedSignature = SopSigner.hmacSign(secretKey, `${pkg.hash}:${pkg.timestamp.toISOString()}`);
    if (pkg.signature !== expectedSignature) {
      return { valid: false, reason: 'signature_mismatch' };
    }
    return { valid: true };
  }

  static verifyPackageWithKey(pkg: SignedSopPackage, publicKey: string): VerifyResult {
    return SopSigner.verifyPackage(pkg, publicKey);
  }

  private static verifyTimestamp(timestamp: Date): VerifyResult {
    const now = Date.now();
    const pkgTime = timestamp.getTime();
    if (now - pkgTime > SopSigner.TIMESTAMP_WINDOW_MS) {
      return { valid: false, reason: 'timestamp_expired' };
    }
    if (pkgTime > now + 60_000) {
      return { valid: false, reason: 'timestamp_from_future' };
    }
    return { valid: true };
  }

  // ─── HMAC 签名 ─────────────────────────────────────────────

  private static hmacSign(key: string, data: string): string {
    return crypto
      .createHmac('sha256', key)
      .update(data)
      .digest('hex');
  }

  // ─── 请求签名（文档 11.2 节） ──────────────────────────────

  /**
   * 生成请求签名
   * 每个 API 请求携带 HMAC-SHA256 签名
   */
  static signRequest(params: SignRequestParams): string {
    const ts = params.timestamp ?? Date.now().toString();
    const payload = `${params.method}:${params.path}:${ts}:${params.nonce}:${JSON.stringify(params.body)}`;
    return SopSigner.hmacSign(params.secretKey, payload);
  }

  /**
   * 验证请求签名
   */
  static verifyRequest(params: VerifyRequestParams): VerifyResult {
    // 验证时间戳（5 分钟有效）
    const now = Date.now();
    const reqTime = parseInt(params.timestamp, 10);
    if (isNaN(reqTime) || now - reqTime > SopSigner.TIMESTAMP_WINDOW_MS) {
      return { valid: false, reason: 'request_expired' };
    }

    const expected = SopSigner.signRequest({
      method: params.method,
      path: params.path,
      body: params.body,
      secretKey: params.secretKey,
      nonce: params.nonce,
      timestamp: params.timestamp,
    });
    if (params.signature !== expected) {
      return { valid: false, reason: 'signature_mismatch' };
    }

    return { valid: true };
  }

  /**
   * 生成 Nonce（唯一随机数）
   */
  static generateNonce(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  // ─── 本地存储加密（文档 11.4 节） ──────────────────────────

  /**
   * 加密规则内容（AES-256-GCM）
   * 密钥由机器硬件指纹 + 用户 ID 派生
   */
  static encryptRules(
    rules: SopRule[],
    machineFingerprint: string,
    userId: string,
  ): EncryptedData {
    const key = SopSigner.deriveKey(machineFingerprint, userId);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const plaintext = JSON.stringify(rules);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('hex'),
      encrypted: encrypted.toString('hex'),
      authTag: authTag.toString('hex'),
      algorithm: 'aes-256-gcm',
    };
  }

  private static deriveKey(machineFingerprint: string, userId: string): Buffer {
    return crypto.pbkdf2Sync(
      `${machineFingerprint}:${userId}`,
      'zhshield-sop-cache',
      100_000,
      32,
      'sha256',
    );
  }

  /**
   * 解密规则内容
   */
  static decryptRules(
    data: EncryptedData,
    machineFingerprint: string,
    userId: string,
  ): SopRule[] {
    const key = SopSigner.deriveKey(machineFingerprint, userId);

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(data.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(data.authTag, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(data.encrypted, 'hex')),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString('utf-8'));
  }
}

// ─── 验证结果 ────────────────────────────────────────────────

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

// ─── 加密数据结构 ────────────────────────────────────────────

export interface EncryptedData {
  iv: string;
  encrypted: string;
  authTag: string;
  algorithm: string;
}
