import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { SopSigner, type SopKeyRing } from '../sop/security/sop-signer';
import type { SignedSopPackage } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

const rules = [makeRule({ id: 'rule-b' }), makeRule({ id: 'rule-a' })];

function makeKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/**
 * 密钥轮换：keyId 写进包与签名原文；轮换后旧 keyId 的密钥留在环里，历史包继续可验。
 * 缺密钥必须 fail-closed，绝不能拿别的密钥顶替。
 */
describe('SopSigner 密钥轮换', () => {
  const v1 = makeKeyPair();
  const v2 = makeKeyPair();

  it('密钥环签名写入 keyId，按 keyId 选钥验签通过', () => {
    const ring: SopKeyRing = { keys: { 'sop-v1': v1.publicKey }, activeKeyId: 'sop-v1' };
    const pkg = SopSigner.signWithKeyRing(rules, { ...ring, keys: { 'sop-v1': v1.privateKey } });
    expect(pkg.keyId).toBe('sop-v1');
    expect(SopSigner.verifyWithKeyRing(pkg, ring).valid).toBe(true);
  });

  it('轮换到新 keyId 后，旧包仍可验（双密钥并存）', () => {
    const oldPkg = SopSigner.signPackage(rules, v1.privateKey, '1.0.0', {
      alg: 'ed25519',
      keyId: 'sop-v1',
    });
    const rotated: SopKeyRing = {
      keys: { 'sop-v1': v1.publicKey, 'sop-v2': v2.publicKey },
      activeKeyId: 'sop-v2',
    };
    const newPkg = SopSigner.signWithKeyRing(rules, {
      keys: { 'sop-v1': v1.privateKey, 'sop-v2': v2.privateKey },
      activeKeyId: 'sop-v2',
    });

    expect(SopSigner.verifyWithKeyRing(oldPkg, rotated).valid).toBe(true);
    expect(SopSigner.verifyWithKeyRing(newPkg, rotated).valid).toBe(true);
    expect(newPkg.keyId).toBe('sop-v2');
  });

  it('无 keyId 的历史包用 legacyKey 验证', () => {
    const legacyPkg = SopSigner.signPackage(rules, v1.privateKey, '0.9.0', 'ed25519');
    expect(legacyPkg.keyId).toBeUndefined();
    const ring: SopKeyRing = {
      keys: { 'sop-v2': v2.publicKey },
      activeKeyId: 'sop-v2',
      legacyKey: v1.publicKey,
    };
    expect(SopSigner.verifyWithKeyRing(legacyPkg, ring).valid).toBe(true);
  });

  it('环里没有该 keyId → fail-closed（unknown_key_id），不拿别的密钥顶替', () => {
    const pkg = SopSigner.signPackage(rules, v1.privateKey, '1.0.0', {
      alg: 'ed25519',
      keyId: 'sop-v1',
    });
    const ring: SopKeyRing = { keys: { 'sop-v2': v2.publicKey }, activeKeyId: 'sop-v2' };
    const result = SopSigner.verifyWithKeyRing(pkg, ring);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unknown_key_id');
  });

  it('历史包缺 legacyKey → fail-closed（legacy_key_missing）', () => {
    const legacyPkg = SopSigner.signPackage(rules, v1.privateKey, '0.9.0', 'ed25519');
    const ring: SopKeyRing = { keys: { 'sop-v2': v2.publicKey }, activeKeyId: 'sop-v2' };
    const result = SopSigner.verifyWithKeyRing(legacyPkg, ring);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('legacy_key_missing');
  });

  it('把包改挂到别的 keyId → 签名不匹配（keyId 参与签名原文）', () => {
    const pkg = SopSigner.signPackage(rules, v1.privateKey, '1.0.0', {
      alg: 'ed25519',
      keyId: 'sop-v1',
    });
    const tampered: SignedSopPackage = { ...pkg, keyId: 'sop-v2' };
    const ring: SopKeyRing = {
      keys: { 'sop-v1': v1.publicKey, 'sop-v2': v2.publicKey },
      activeKeyId: 'sop-v2',
    };
    const result = SopSigner.verifyWithKeyRing(tampered, ring);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('activeKeyId 缺密钥时签名侧直接报错（不签出一个无法验证的包）', () => {
    const ring: SopKeyRing = { keys: {}, activeKeyId: 'sop-v9' };
    expect(() => SopSigner.signWithKeyRing(rules, ring)).toThrow('sop-v9');
  });
});
