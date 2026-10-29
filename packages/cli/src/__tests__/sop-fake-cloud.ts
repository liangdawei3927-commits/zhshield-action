import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { SopSigner } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';

/**
 * 测试用的假云大脑：真起一个 HTTP 服务，不 mock `fetch`。
 *
 * 为什么不用 vi.mock('node:fetch')：验签链路里最容易错的是**序列化往返** ——
 * 签名端把 `Date` 签进去，传输时变字符串，客户端要能还原成 `Date` 再算哈希。
 * mock 掉 fetch 就把这段真实转换也 mock 掉了，用例会绿而线上恒 reject。
 * 起真服务 + 真 brotli + 真 JSON 往返，才能覆盖到那个接缝。
 */

export interface FakeCloudOptions {
  readonly rules: readonly SopRule[];
  /** 签名私钥 PEM；不给 = 服务端未配置签名密钥，返回裸规则数组 */
  readonly privateKeyPem?: string;
  /** `/public-key` 返回的公钥；null = 服务端未配置；undefined = 不给该公钥（用 keyPair 里的） */
  readonly publicKeyPem?: string | null;
  readonly version?: string;
  /** `/full/:version` 强制返回指定 HTTP 状态（模拟 5xx/401） */
  readonly fullStatus?: number;
}

export interface FakeCloud {
  readonly base: string;
  readonly requests: string[];
  close(): Promise<void>;
}

/** 起假服务；返回 `{base, requests, close}`。`base` 已含 `/sop` 后缀，可直接当 sopBase */
export async function startFakeCloud(options: FakeCloudOptions): Promise<FakeCloud> {
  const requests: string[] = [];
  const version = options.version ?? '1.2026.10.29.001';

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    requests.push(url);

    if (url === '/sop/public-key') {
      return sendJson(res, { publicKey: options.publicKeyPem ?? null });
    }
    if (url === '/sop/version') {
      return sendJson(res, { version, hash: 'f'.repeat(64), publishedAt: '2026-10-29T00:00:00.000Z' });
    }
    if (url.startsWith('/sop/full/')) {
      if (options.fullStatus) {
        res.writeHead(options.fullStatus).end('boom');
        return undefined;
      }
      return sendFull(res, options.rules, version, options.privateKeyPem);
    }
    res.writeHead(404).end('not found');
    return undefined;
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    base: `http://127.0.0.1:${port}/sop`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function sendJson(res: http.ServerResponse, body: unknown): undefined {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  return undefined;
}

/** 全量包：配了私钥就签名，否则回裸规则数组（旧版服务端 / 未配额的自建部署） */
function sendFull(
  res: http.ServerResponse,
  rules: readonly SopRule[],
  version: string,
  privateKeyPem?: string,
): undefined {
  const payload = privateKeyPem
    ? SopSigner.signPackage([...rules], privateKeyPem, version)
    : [...rules];
  const compressed = zlib.brotliCompressSync(Buffer.from(JSON.stringify(payload)));
  res
    .writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'br' })
    .end(compressed);
  return undefined;
}

/** 生成一对 Ed25519 密钥（PEM）。测试里现生成，避免把私钥签进仓库 */
export function generateKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

let ruleCounter = 0;

/** 造一条最小可用的规则；`domain` 决定落盘文件名 */
export function makeRule(overrides: Partial<SopRule> & { domain?: string } = {}): SopRule {
  ruleCounter += 1;
  const domain = overrides.domain ?? 'guard';
  return {
    id: `${domain}.block.official.fixture-${ruleCounter}`,
    name: `fixture-${ruleCounter}`,
    domain,
    action: 'block',
    source: 'official',
    description: 'fixture rule',
    status: 'active',
    executionMode: 'sync',
    severity: 'error',
    applicableEngines: [],
    content: {},
    tags: [],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as SopRule;
}

/** 造一条已登记为扫描后门禁的规则（id 命中 POST_SCAN_GATE_BINDINGS） */
export function makeGateRule(): SopRule {
  return makeRule({
    id: 'guard.block.official.test-coverage',
    name: 'test-coverage',
    content: { threshold: 80, unit: 'percent', executionStage: 'post-scan' },
  });
}
