import { describe, it, expect } from 'vitest';
import { SopSigner } from '../sop/security/sop-signer';
import { makeRule } from './helpers/rule-factory';

const SECRET = 'test-secret-key';
const HEX32 = /^[0-9a-f]{32}$/;

describe('SopSigner', () => {
  const rules = [makeRule({ id: 'rule-b' }), makeRule({ id: 'rule-a' })];

  // ─── 规则包签名/验证 ─────────────────────────────
  describe('signPackage / verifyPackage', () => {
    it('有效签名包应验证通过（往返），且规则按 ID 排序', () => {
      const pkg = SopSigner.signPackage(rules, SECRET, '1.0.0');
      expect(pkg.version).toBe('1.0.0');
      expect(pkg.rules.map((r) => r.id)).toEqual(['rule-a', 'rule-b']);
      const result = SopSigner.verifyPackage(pkg, SECRET);
      expect(result.valid).toBe(true);
    });

    it('时间戳过期应拒绝（防重放攻击）', () => {
      const pkg = SopSigner.signPackage(rules, SECRET);
      const expired = { ...pkg, timestamp: new Date(Date.now() - 6 * 60 * 1000) };
      const result = SopSigner.verifyPackage(expired, SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('timestamp_expired');
    });

    it('时间戳来自未来应拒绝', () => {
      const pkg = SopSigner.signPackage(rules, SECRET);
      const future = { ...pkg, timestamp: new Date(Date.now() + 2 * 60 * 1000) };
      const result = SopSigner.verifyPackage(future, SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('timestamp_from_future');
    });

    it('规则被篡改应拒绝（hash 不匹配，防篡改）', () => {
      const pkg = SopSigner.signPackage(rules, SECRET);
      const tampered = { ...pkg, rules: [...rules, makeRule({ id: 'injected' })] };
      const result = SopSigner.verifyPackage(tampered, SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('hash_mismatch');
    });

    it('错误密钥应拒绝（签名不匹配，防伪造）', () => {
      const pkg = SopSigner.signPackage(rules, SECRET);
      const result = SopSigner.verifyPackage(pkg, 'wrong-secret');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    });
  });

  // ─── 请求签名 ─────────────────────────────────────
  describe('signRequest / verifyRequest', () => {
    it('有效请求签名应验证通过（往返）', () => {
      const ts = Date.now().toString();
      const sig = SopSigner.signRequest({ method: 'POST', path: '/api/v1/rules', body: { a: 1 }, secretKey: SECRET, nonce: 'nonce-1', timestamp: ts });
      const result = SopSigner.verifyRequest({ method: 'POST', path: '/api/v1/rules', body: { a: 1 }, secretKey: SECRET, nonce: 'nonce-1', signature: sig, timestamp: ts });
      expect(result.valid).toBe(true);
    });

    it('过期请求应拒绝（防重放）', () => {
      const ts = (Date.now() - 6 * 60 * 1000).toString();
      const sig = SopSigner.signRequest({ method: 'POST', path: '/api', body: {}, secretKey: SECRET, nonce: 'n', timestamp: ts });
      const result = SopSigner.verifyRequest({ method: 'POST', path: '/api', body: {}, secretKey: SECRET, nonce: 'n', signature: sig, timestamp: ts });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('request_expired');
    });

    it('无效时间戳应拒绝', () => {
      const result = SopSigner.verifyRequest({ method: 'POST', path: '/api', body: {}, secretKey: SECRET, nonce: 'n', signature: 'sig', timestamp: 'not-a-number' });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('request_expired');
    });

    it('签名不匹配应拒绝（防伪造）', () => {
      const ts = Date.now().toString();
      const sig = SopSigner.signRequest({ method: 'POST', path: '/api', body: {}, secretKey: 'secret-a', nonce: 'n', timestamp: ts });
      const result = SopSigner.verifyRequest({ method: 'POST', path: '/api', body: {}, secretKey: 'secret-b', nonce: 'n', signature: sig, timestamp: ts });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    });
  });

  // ─── Nonce ────────────────────────────────────────
  describe('generateNonce', () => {
    it('应生成 32 位十六进制字符串且每次不同', () => {
      const n1 = SopSigner.generateNonce();
      const n2 = SopSigner.generateNonce();
      expect(n1).toMatch(HEX32);
      expect(n1).not.toBe(n2);
    });
  });

  // ─── 本地存储加密 ─────────────────────────────────
  describe('encryptRules / decryptRules', () => {
    it('加密后解密应还原原规则（往返）', () => {
      const encrypted = SopSigner.encryptRules(rules, 'fingerprint', 'user-1');
      expect(encrypted.algorithm).toBe('aes-256-gcm');
      expect(encrypted.iv).toHaveLength(32); // 16 bytes → 32 hex chars
      const decrypted = SopSigner.decryptRules(encrypted, 'fingerprint', 'user-1');
      expect(decrypted.map((r) => r.id)).toEqual(['rule-b', 'rule-a']);
    });

    it('错误密钥（不同指纹）应解密失败', () => {
      const encrypted = SopSigner.encryptRules(rules, 'fp-a', 'user-1');
      expect(() => SopSigner.decryptRules(encrypted, 'fp-b', 'user-1')).toThrow();
    });

    it('篡改密文应解密失败（完整性保护）', () => {
      const encrypted = SopSigner.encryptRules(rules, 'fp', 'user-1');
      const tampered = { ...encrypted, authTag: '00'.repeat(16) };
      expect(() => SopSigner.decryptRules(tampered, 'fp', 'user-1')).toThrow();
    });

    it('GCM 解密显式校验 16 字节 authTag：截断标签必须被拒绝', () => {
      const encrypted = SopSigner.encryptRules(rules, 'fp', 'user-1');
      // 将 authTag 截断为 8 字节（32 hex → 16 hex）：显式 authTagLength:16 下必须失败
      const truncated = { ...encrypted, authTag: encrypted.authTag.slice(0, 16) };
      expect(() => SopSigner.decryptRules(truncated, 'fp', 'user-1')).toThrow();
    });
  });
});
