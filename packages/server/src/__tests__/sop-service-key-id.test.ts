import { describe, it, expect, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import { SopSigner } from '@zh/kernel';
import { SopService } from '../sop/sop.service';
import type { SopContentRepository } from '../sop/sop-content.repository';

/** 签名链路需要的内容仓库：本用例只测签名侧，规则表为空即可 */
const stubRepo = { getAllRules: () => [] } as unknown as SopContentRepository;

function makeKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

afterEach(() => {
  delete process.env.ZH_SOP_PRIVATE_KEY;
  delete process.env.ZH_SOP_KEY_ID;
});

describe('SopService 签名密钥 id', () => {
  it('设 ZH_SOP_KEY_ID 时签名包带 keyId，且仍可用公钥验签', () => {
    const { privateKey, publicKey } = makeKeyPair();
    process.env.ZH_SOP_PRIVATE_KEY = privateKey;
    process.env.ZH_SOP_KEY_ID = 'sop-v2';
    const service = new SopService(stubRepo);

    const pkg = service.signPackage();
    expect(pkg.keyId).toBe('sop-v2');
    expect(service.keyId).toBe('sop-v2');
    expect(SopSigner.verifyPackageWithPublicKey(pkg, publicKey).valid).toBe(true);
  });

  it('未设 ZH_SOP_KEY_ID 时保持历史格式（无 keyId），旧验签路径不变', () => {
    const { privateKey, publicKey } = makeKeyPair();
    process.env.ZH_SOP_PRIVATE_KEY = privateKey;
    const service = new SopService(stubRepo);

    const pkg = service.signPackage();
    expect(pkg.keyId).toBeUndefined();
    expect(service.keyId).toBeNull();
    expect(SopSigner.verifyPackageWithPublicKey(pkg, publicKey).valid).toBe(true);
  });
});
