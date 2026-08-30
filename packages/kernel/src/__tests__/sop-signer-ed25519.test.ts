import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { SopSigner } from '../sop/security/sop-signer';
import type { SignedSopPackage } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

const SECRET = 'test-secret-key';

/** 生成一对 Ed25519 PEM 密钥（私钥 PKCS8 / 公钥 SPKI） */
function makeKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const rules = [makeRule({ id: 'rule-b' }), makeRule({ id: 'rule-a' })];

describe('SopSigner Ed25519 兼容矩阵', () => {
  const { privateKey, publicKey } = makeKeyPair();

  describe('旧 HMAC 包（无 alg）仍可验签', () => {
    it('GIVEN 无 alg 的 HMAC 包 WHEN verifyPackage THEN 走 HMAC 路径通过', () => {
      const pkg = SopSigner.signPackage(rules, SECRET, '1.0.0');
      expect(pkg.alg).toBe('hmac-sha256');
      const legacy = { ...pkg } as SignedSopPackage;
      delete (legacy as { alg?: string }).alg;
      const result = SopSigner.verifyPackage(legacy, SECRET);
      expect(result.valid).toBe(true);
    });
  });

  describe('新 Ed25519 包（alg=ed25519）用公钥验签', () => {
    it('GIVEN Ed25519 私钥签名 WHEN 用公钥 verifyPackage THEN 通过', () => {
      const pkg = SopSigner.signPackage(rules, privateKey, '2.0.0');
      expect(pkg.alg).toBe('ed25519');
      const result = SopSigner.verifyPackage(pkg, publicKey);
      expect(result.valid).toBe(true);
    });

    it('GIVEN Ed25519 私钥签名 WHEN verifyPackageWithPublicKey THEN 通过', () => {
      const pkg = SopSigner.signPackage(rules, privateKey, '2.0.0');
      const result = SopSigner.verifyPackageWithPublicKey(pkg, publicKey);
      expect(result.valid).toBe(true);
    });
  });

  describe('篡改 rules/hash/timestamp → 验签失败', () => {
    it('GIVEN 篡改 rules WHEN 验签 THEN hash_mismatch', () => {
      const pkg = SopSigner.signPackage(rules, privateKey);
      const tampered = { ...pkg, rules: [...rules, makeRule({ id: 'injected' })] };
      const result = SopSigner.verifyPackage(tampered, publicKey);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('hash_mismatch');
    });

    it('GIVEN 篡改 hash WHEN 验签 THEN hash_mismatch', () => {
      const pkg = SopSigner.signPackage(rules, privateKey);
      const tampered = { ...pkg, hash: 'deadbeef' };
      const result = SopSigner.verifyPackage(tampered, publicKey);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('hash_mismatch');
    });

    it('GIVEN 篡改 timestamp WHEN 验签 THEN signature_mismatch', () => {
      const pkg = SopSigner.signPackage(rules, privateKey);
      const tampered = { ...pkg, timestamp: new Date(Date.now() - 60_000) };
      const result = SopSigner.verifyPackage(tampered, publicKey);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    });
  });

  describe('错误公钥 → 失败', () => {
    it('GIVEN 另一对密钥的公钥 WHEN 验签 THEN signature_mismatch', () => {
      const other = makeKeyPair();
      const pkg = SopSigner.signPackage(rules, privateKey);
      const result = SopSigner.verifyPackage(pkg, other.publicKey);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    });
  });

  describe('未知 alg → fail-closed（非静默 HMAC）', () => {
    it('GIVEN alg=unknown WHEN verifyPackage THEN unknown_alg 且不降级 HMAC', () => {
      const pkg = SopSigner.signPackage(rules, privateKey);
      const unknown = { ...pkg, alg: 'unknown' as never };
      const result = SopSigner.verifyPackage(unknown, SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('unknown_alg');
    });
  });

  describe('跨算法负例（无算法混淆）', () => {
    it('GIVEN HMAC 包 WHEN 用 Ed25519 公钥验签 THEN 失败', () => {
      const pkg = SopSigner.signPackage(rules, SECRET);
      const result = SopSigner.verifyPackage(pkg, publicKey);
      expect(result.valid).toBe(false);
    });

    it('GIVEN Ed25519 包 WHEN 用 HMAC 对称密钥验签 THEN 失败', () => {
      const pkg = SopSigner.signPackage(rules, privateKey);
      const result = SopSigner.verifyPackage(pkg, SECRET);
      expect(result.valid).toBe(false);
    });
  });

  describe('PEM 往返与 base64 签名 JSON 往返', () => {
    it('GIVEN PEM 私钥签名 + PEM 公钥验签 WHEN 往返 THEN 通过', () => {
      const pkg = SopSigner.signPackage(rules, privateKey, '3.0.0');
      expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
      expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
      expect(SopSigner.verifyPackage(pkg, publicKey).valid).toBe(true);
    });

    it('GIVEN 签名包经 JSON 序列化/反序列化（含 Date 还原）WHEN 验签 THEN 通过', () => {
      const pkg = SopSigner.signPackage(rules, privateKey, '3.1.0');
      const revived: SignedSopPackage = {
        ...pkg,
        timestamp: new Date(pkg.timestamp),
        rules: pkg.rules.map((r) => ({
          ...r,
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt),
          lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt) : undefined,
        })),
      };
      expect(SopSigner.verifyPackage(revived, publicKey).valid).toBe(true);
    });
  });

  describe('重放窗口拆分', () => {
    /** 构造一个在指定时间真实签名的 Ed25519 包（签名输入含该时间戳） */
    function signAt(timestamp: Date): SignedSopPackage {
      const sorted = rules.toSorted((a, b) => a.id.localeCompare(b.id));
      const content = JSON.stringify(sorted);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const data = `${hash}:${timestamp.toISOString()}`;
      const key = crypto.createPrivateKey(privateKey);
      const signature = crypto.sign(null, Buffer.from(data, 'utf-8'), key).toString('base64');
      return { version: '1.0.0', rules: sorted, signature, hash, timestamp, alg: 'ed25519' };
    }

    it('GIVEN 6 分钟前真实签名的缓存包 WHEN 用 cache 窗口验签 THEN 通过', () => {
      const oldPkg = signAt(new Date(Date.now() - 6 * 60 * 1000));
      const result = SopSigner.verifyPackage(oldPkg, publicKey, {
        windowMs: SopSigner.CACHE_WINDOW_MS,
      });
      expect(result.valid).toBe(true);
    });

    it('GIVEN 6 分钟前真实签名的缓存包 WHEN 用 request 窗口验签 THEN timestamp_expired', () => {
      const oldPkg = signAt(new Date(Date.now() - 6 * 60 * 1000));
      const result = SopSigner.verifyPackage(oldPkg, publicKey);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('timestamp_expired');
    });
  });
});
