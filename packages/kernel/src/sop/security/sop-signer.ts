import * as crypto from 'node:crypto';
import type { SopRule, SignedSopAlg, SignedSopPackage } from '../_meta/sop-types';

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

// ─── 模块级私有签名原语 ───────────────────────────────────────
// 这些是 SopSigner 的底层实现，独立于类外以控制类体规模（仓库 large-class ≤300 门禁）。
// 仅被类内公开方法调用，不对外导出。

function canonicalTimestamp(timestamp: Date | string): string {
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function isPrivateKeyPem(key: string): boolean {
  return key.includes('-----BEGIN PRIVATE KEY-----');
}

function hmacSign(key: string, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function verifyTimestamp(timestamp: Date | string, windowMs: number): VerifyResult {
  const now = Date.now();
  const pkgTime = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (now - pkgTime > windowMs) {
    return { valid: false, reason: 'timestamp_expired' };
  }
  if (pkgTime > now + 60_000) {
    return { valid: false, reason: 'timestamp_from_future' };
  }
  return { valid: true };
}

/** 用 Ed25519 私钥（PEM PKCS8）签名规则包。签名输入 `${hash}:${timestamp.toISOString()}` 与 HMAC 路径逐字节一致。 */
function signEd25519(rules: SopRule[], privateKey: string, version?: string): SignedSopPackage {
  const sorted = rules.toSorted((a, b) => a.id.localeCompare(b.id));
  const content = JSON.stringify(sorted);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const timestamp = new Date();
  const data = `${hash}:${canonicalTimestamp(timestamp)}`;
  const key = crypto.createPrivateKey(privateKey);
  const signature = crypto.sign(null, Buffer.from(data, 'utf-8'), key).toString('base64');
  return {
    version: version ?? '0.0.0',
    rules: sorted,
    signature,
    hash,
    timestamp,
    alg: 'ed25519',
  };
}

/** 用 Ed25519 公钥（PEM SPKI）验证规则包签名 */
function verifyEd25519(pkg: SignedSopPackage, publicKey: string, windowMs: number): VerifyResult {
  const tsResult = verifyTimestamp(pkg.timestamp, windowMs);
  if (!tsResult.valid) return tsResult;
  const sorted = pkg.rules.toSorted((a, b) => a.id.localeCompare(b.id));
  const content = JSON.stringify(sorted);
  const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
  if (pkg.hash !== expectedHash) {
    return { valid: false, reason: 'hash_mismatch' };
  }
  const data = `${pkg.hash}:${canonicalTimestamp(pkg.timestamp)}`;
  try {
    const key = crypto.createPublicKey(publicKey);
    const valid = crypto.verify(
      null,
      Buffer.from(data, 'utf-8'),
      key,
      Buffer.from(pkg.signature, 'base64'),
    );
    return valid ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
  } catch {
    return { valid: false, reason: 'signature_mismatch' };
  }
}

/** HMAC-SHA256 签名规则包（旧对称路径，兼容旧验证与回滚） */
function signHmac(rules: SopRule[], secretKey: string, version?: string): SignedSopPackage {
  const sorted = rules.toSorted((a, b) => a.id.localeCompare(b.id));
  const content = JSON.stringify(sorted);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const timestamp = new Date();
  const signature = hmacSign(secretKey, `${hash}:${canonicalTimestamp(timestamp)}`);
  return {
    version: version ?? '0.0.0',
    rules: sorted,
    signature,
    hash,
    timestamp,
    alg: 'hmac-sha256',
  };
}

/** HMAC-SHA256 验证规则包（旧对称路径） */
function verifyHmac(pkg: SignedSopPackage, secretKey: string, windowMs: number): VerifyResult {
  const tsResult = verifyTimestamp(pkg.timestamp, windowMs);
  if (!tsResult.valid) return tsResult;
  const sorted = pkg.rules.toSorted((a, b) => a.id.localeCompare(b.id));
  const content = JSON.stringify(sorted);
  const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
  if (pkg.hash !== expectedHash) {
    return { valid: false, reason: 'hash_mismatch' };
  }
  const expectedSignature = hmacSign(secretKey, `${pkg.hash}:${canonicalTimestamp(pkg.timestamp)}`);
  if (pkg.signature !== expectedSignature) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

/**
 * SopSigner — 规则包签名与验证（文档 11.3 节）
 *
 * 保护规则的机密性和完整性：
 * - 传输安全：HTTPS + TLS 1.3
 * - 规则包签名：Ed25519（或旧 HMAC-SHA256，向后兼容）
 * - 防重放攻击：时间戳 + Nonce
 * - 本地存储加密：AES-256-GCM
 *
 * 底层签名/哈希原语为模块级私有函数，本类仅保留公开入口与算法分发。
 */
export class SopSigner {
  /** 请求签名时间戳有效窗口（5 分钟） */
  private static readonly REQUEST_WINDOW_MS = 5 * 60 * 1000;
  /** 规则包缓存时间戳窗口（大值：签名证真伪，新鲜度归缓存层 TTL） */
  static readonly CACHE_WINDOW_MS = 24 * 60 * 60 * 1000;

  // ─── 规则包签名 ────────────────────────────────────────────

  /**
   * 签名规则包（云端签名）
   * 文档 11.3 节：
   * 1. 规则按 ID 排序后序列化
   * 2. 计算 SHA-256 哈希
   * 3. 签名（Ed25519 或 HMAC-SHA256）
   *
   * 算法选择：显式 alg 优先；否则按 key 格式推断 —— PEM PKCS8 私钥 → Ed25519，
   * 普通字符串 → HMAC-SHA256（旧对称密钥，向后兼容）。
   */
  static signPackage(
    rules: SopRule[],
    key: string,
    version?: string,
    alg?: SignedSopAlg,
  ): SignedSopPackage {
    const resolvedAlg = alg ?? (isPrivateKeyPem(key) ? 'ed25519' : 'hmac-sha256');
    if (resolvedAlg === 'ed25519') return signEd25519(rules, key, version);
    return signHmac(rules, key, version);
  }

  /**
   * 验证签名（桌面端验证）
   * 文档 11.3 节：
   * 1. 验证时间戳（防止重放攻击）
   * 2. 验证哈希（防止篡改）
   * 3. 验证签名（防止伪造）
   *
   * 按 pkg.alg 分发：'ed25519' → Ed25519 公钥路径；缺省/'hmac-sha256' → 旧 HMAC 路径；
   * 其它值 → fail-closed（unknown_alg），绝不静默降级 HMAC。
   */
  static verifyPackage(
    pkg: SignedSopPackage,
    key: string,
    opts?: { windowMs?: number },
  ): VerifyResult {
    const windowMs = opts?.windowMs ?? SopSigner.REQUEST_WINDOW_MS;
    switch (pkg.alg) {
      case 'ed25519':
        return verifyEd25519(pkg, key, windowMs);
      case undefined:
      case 'hmac-sha256':
        return verifyHmac(pkg, key, windowMs);
      default:
        // 运行时不可表示值（来自不可信 JSON）：fail-closed，绝不静默降级 HMAC
        return { valid: false, reason: 'unknown_alg' };
    }
  }

  /** 用 Ed25519 公钥验证规则包（按 pkg.alg 分发） */
  static verifyPackageWithPublicKey(
    pkg: SignedSopPackage,
    publicKey: string,
    opts?: { windowMs?: number },
  ): VerifyResult {
    return SopSigner.verifyPackage(pkg, publicKey, opts);
  }

  /**
   * @deprecated 旧名：HMAC 兼容别名，内部按 pkg.alg 分发（HMAC 包用对称密钥，Ed25519 包用公钥）。
   * 新代码请使用 verifyPackageWithPublicKey。
   */
  static verifyPackageWithKey(
    pkg: SignedSopPackage,
    key: string,
    opts?: { windowMs?: number },
  ): VerifyResult {
    return SopSigner.verifyPackage(pkg, key, opts);
  }

  // ─── 请求签名（文档 11.2 节） ──────────────────────────────

  /**
   * 生成请求签名
   * 每个 API 请求携带 HMAC-SHA256 签名
   */
  static signRequest(params: SignRequestParams): string {
    const ts = params.timestamp ?? Date.now().toString();
    const payload = `${params.method}:${params.path}:${ts}:${params.nonce}:${JSON.stringify(params.body)}`;
    return hmacSign(params.secretKey, payload);
  }

  /**
   * 验证请求签名
   */
  static verifyRequest(params: VerifyRequestParams): VerifyResult {
    // 验证时间戳（5 分钟有效）
    const now = Date.now();
    const reqTime = parseInt(params.timestamp, 10);
    if (isNaN(reqTime) || now - reqTime > SopSigner.REQUEST_WINDOW_MS) {
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
  static encryptRules(rules: SopRule[], machineFingerprint: string, userId: string): EncryptedData {
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
  static decryptRules(data: EncryptedData, machineFingerprint: string, userId: string): SopRule[] {
    const key = SopSigner.deriveKey(machineFingerprint, userId);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'hex'), {
      authTagLength: 16,
    });
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
