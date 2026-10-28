import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SopCacheManager } from '../sop/cache/sop-cache-manager';
import { VerifiedSopSyncClient } from '../sop/cache/sop-verified-sync-client';
import { SopSignatureVerifier } from '../sop/cache/sop-signature-verifier';
import { SopCompressor, CompressionFormat } from '../sop/cache/sop-compressor';
import { SopSigner } from '../sop/security/sop-signer';
import type { SopRegistry } from '../sop/_meta/sop-registry';
import type { SignedSopPackage, SopRule, SopVersion } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

const SECRET = 'test-signing-secret';
const OTHER_SECRET = 'other-secret';

/** 故意乱序的规则列表（signPackage 内部会按 id 排序） */
function makeRules(): SopRule[] {
  return [makeRule({ id: 'b.rule' }), makeRule({ id: 'a.rule' }), makeRule({ id: 'c.rule' })];
}

function makeRegistryMock(rules: SopRule[] = []): SopRegistry {
  return {
    getAll: () => rules,
    loadAll: vi.fn(),
  } as unknown as SopRegistry;
}

/** 构造一个 mock Response（同 sop-sync-client.test.ts 模式） */
function makeResponse(
  body: unknown,
  opts: { ok?: boolean; status?: number; contentType?: string } = {},
): Response {
  const ok = opts.ok ?? true;
  const status = opts.status ?? (ok ? 200 : 500);
  const headers = new Headers();
  if (opts.contentType) headers.set('content-type', opts.contentType);
  return {
    ok,
    status,
    headers,
    json: async () => body as never,
    arrayBuffer: async () => body as ArrayBuffer,
  } as unknown as Response;
}

async function brotliBody(value: unknown): Promise<ArrayBuffer> {
  const compressor = new SopCompressor();
  const compressed = await compressor.compress(
    Buffer.from(JSON.stringify(value), 'utf-8'),
    CompressionFormat.Brotli,
  );
  return compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength,
  );
}

describe('SopSignatureVerifier.getPublicKey / verifySignature', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zh-cache-verify-${crypto.randomUUID()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  function makeVerifier(publicKey?: string | (() => Promise<string | null>)): SopSignatureVerifier {
    return new SopSignatureVerifier(publicKey);
  }

  describe('getPublicKey', () => {
    it('GIVEN 未配置 publicKey WHEN getPublicKey THEN 返回 null', async () => {
      expect(await makeVerifier().getPublicKey()).toBeNull();
    });

    it('GIVEN publicKey 为字符串 WHEN getPublicKey THEN 返回该字符串', async () => {
      expect(await makeVerifier(SECRET).getPublicKey()).toBe(SECRET);
    });

    it('GIVEN publicKey 为函数 WHEN getPublicKey THEN 返回解析结果', async () => {
      expect(await makeVerifier(async () => SECRET).getPublicKey()).toBe(SECRET);
    });
  });

  describe('verifySignature', () => {
    /**
     * 口径变更（2026-10-29）：原实现未配置 publicKey ⇒ **放行**（向后兼容），
     * 且带一个全仓无人传的 strict 开关。那等于「忘了配公钥 = 不验签」，
     * 与桌面端 ipc/sync.ts 的 no_public_key → 拒绝口径相反。
     * 现统一为 fail-closed：拿不到公钥就拒收，并告警一次。
     */
    it('GIVEN 未配置 publicKey WHEN 验证任意包 THEN 拒绝（fail-closed，不再向后兼容放行）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pkg = SopSigner.signPackage(makeRules(), OTHER_SECRET);

      expect(await makeVerifier().verifySignature(pkg)).toBe(false);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('未配置验签公钥');

      warnSpy.mockRestore();
    });

    it('未配置公钥的告警只打一次（周期同步不得刷屏）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const verifier = makeVerifier();
      const pkg = SopSigner.signPackage(makeRules(), SECRET);

      await verifier.verifySignature(pkg);
      await verifier.verifySignature(pkg);
      await verifier.verifySignature(pkg);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('GIVEN 公钥函数返回 null WHEN 验证 THEN 返回 false（fail-closed）', async () => {
      const pkg = SopSigner.signPackage(makeRules(), SECRET);
      expect(await makeVerifier(async () => null).verifySignature(pkg)).toBe(false);
    });

    it('GIVEN 字符串公钥与合法签名包 WHEN 验证 THEN 返回 true', async () => {
      const pkg = SopSigner.signPackage(makeRules(), SECRET, '1.2.0');
      expect(await makeVerifier(SECRET).verifySignature(pkg)).toBe(true);
    });

    it('GIVEN 函数公钥与合法签名包 WHEN 验证 THEN 返回 true', async () => {
      const pkg = SopSigner.signPackage(makeRules(), SECRET);
      expect(await makeVerifier(async () => SECRET).verifySignature(pkg)).toBe(true);
    });

    it('GIVEN 规则内容被篡改 WHEN 验证 THEN 返回 false（哈希不匹配）', async () => {
      const pkg = SopSigner.signPackage(makeRules(), SECRET);
      const tampered: SignedSopPackage = {
        ...pkg,
        rules: [{ ...pkg.rules[0], content: { injected: true } }, ...pkg.rules.slice(1)],
      };
      expect(await makeVerifier(SECRET).verifySignature(tampered)).toBe(false);
    });

    it('GIVEN 密钥不匹配 WHEN 验证 THEN 返回 false（签名不匹配）', async () => {
      const pkg = SopSigner.signPackage(makeRules(), SECRET);
      expect(await makeVerifier(OTHER_SECRET).verifySignature(pkg)).toBe(false);
    });
  });
});

describe('VerifiedSopSyncClient.fetchFull — 远程数据验签拦截', () => {
  const baseUrl = 'https://sop.example.com/api/sop';
  let cacheDir: string;
  let verifier: SopSignatureVerifier;
  let client: VerifiedSopSyncClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zh-cache-vclient-${crypto.randomUUID()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    verifier = new SopSignatureVerifier(SECRET);
    client = new VerifiedSopSyncClient(baseUrl, (pkg) => verifier.verifySignature(pkg));
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('GIVEN 裸规则数组响应 WHEN fetchFull THEN 原样放行（向后兼容）', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(await brotliBody(makeRules())));
    const result = await client.fetchFull('3.0.0');
    if (!result.ok) throw new Error(`期望放行，实际被拒: ${result.failure.kind}`);
    expect(result.data.length).toBe(3);
  });

  it('GIVEN 合法签名包响应 WHEN fetchFull THEN 返回包内规则', async () => {
    const pkg = SopSigner.signPackage(makeRules(), SECRET, '3.0.0');
    fetchMock.mockResolvedValueOnce(makeResponse(await brotliBody(pkg)));
    const result = await client.fetchFull('3.0.0');
    if (!result.ok) throw new Error(`期望通过验签，实际被拒: ${result.failure.kind}`);
    expect(result.data.map((r) => r.id)).toEqual(['a.rule', 'b.rule', 'c.rule']);
  });

  it('GIVEN 被篡改的签名包响应 WHEN fetchFull THEN 拒收并归 signature_rejected（安全事件不得伪装成网络错误）', async () => {
    const pkg = SopSigner.signPackage(makeRules(), SECRET);
    const tampered = {
      ...pkg,
      rules: [{ ...pkg.rules[0], content: { injected: true } }, ...pkg.rules.slice(1)],
    };
    fetchMock.mockResolvedValueOnce(makeResponse(await brotliBody(tampered)));
    const result = await client.fetchFull('3.0.0');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('signature_rejected');
  });

  it('GIVEN 错误密钥签名的响应 WHEN fetchFull THEN 拒收并归 signature_rejected', async () => {
    const pkg = SopSigner.signPackage(makeRules(), OTHER_SECRET);
    fetchMock.mockResolvedValueOnce(makeResponse(await brotliBody(pkg)));
    const result = await client.fetchFull('3.0.0');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('signature_rejected');
  });

  it('GIVEN 既非规则数组也非签名包的响应 WHEN fetchFull THEN 归 decode_error（协议不匹配）', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(await brotliBody({ hello: 'world' })));
    const result = await client.fetchFull('3.0.0');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('decode_error');
  });
});

describe('SopCacheManager.syncFromCloud — 全量同步前强制验签', () => {
  let cacheDir: string;
  let manager: SopCacheManager;
  let registryMock: SopRegistry;
  let fetchMock: ReturnType<typeof vi.fn>;

  const remoteVersion: SopVersion = {
    version: '9.9.9',
    knowledge: 'k',
    experience: 'e',
    malware: 'm',
    publishedAt: new Date('2026-08-01T00:00:00Z'),
    hash: 'sha256-abc',
    size: 1024,
  };

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zh-cache-sync-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(cacheDir, 'modules'), { recursive: true });
    registryMock = makeRegistryMock();
    manager = new SopCacheManager(registryMock, { cacheDir, publicKey: SECRET });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // /version → 新版本；/diff → 404 触发全量降级
    fetchMock.mockImplementation((url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/version')) {
        return Promise.resolve(makeResponse(remoteVersion));
      }
      if (target.includes('/diff')) {
        return Promise.resolve(makeResponse(null, { ok: false, status: 404 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${target}`));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  function mockFullPayload(payload: unknown): void {
    fetchMock.mockImplementation((url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/version')) {
        return Promise.resolve(makeResponse(remoteVersion));
      }
      if (target.includes('/diff')) {
        return Promise.resolve(makeResponse(null, { ok: false, status: 404 }));
      }
      if (target.includes('/full/')) {
        return Promise.resolve(makeResponse(brotliBody(payload)));
      }
      return Promise.reject(new Error(`unexpected fetch: ${target}`));
    });
  }

  it('GIVEN 合法签名全量包 WHEN syncFromCloud THEN 接受并写入注册中心', async () => {
    const pkg = SopSigner.signPackage(makeRules(), SECRET, '9.9.9');
    mockFullPayload(pkg);

    const result = await manager.syncFromCloud();

    expect(result.updated).toBe(true);
    expect(result.toVersion).toBe('9.9.9');
    expect(registryMock.loadAll).toHaveBeenCalledWith(pkg.rules);
  });

  it('GIVEN 被篡改的全量包 WHEN syncFromCloud THEN 拒绝写入（缓存投毒防护）', async () => {
    const pkg = SopSigner.signPackage(makeRules(), SECRET);
    const tampered = {
      ...pkg,
      rules: [{ ...pkg.rules[0], content: { injected: true } }, ...pkg.rules.slice(1)],
    };
    mockFullPayload(tampered);

    const result = await manager.syncFromCloud();

    expect(result.updated).toBe(false);
    // 归因必须一路透到 SyncResult：原来一律报 network_error，投毒被伪装成"网络不好"
    expect(result.reason).toBe('signature_rejected');
    expect(result.detail).toContain('验签');
    expect(registryMock.loadAll).not.toHaveBeenCalled();
  });
});
