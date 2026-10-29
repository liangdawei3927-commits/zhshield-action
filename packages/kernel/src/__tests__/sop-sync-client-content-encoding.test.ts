import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as zlib from 'node:zlib';

import { SopSyncClient } from '../sop/cache/sop-sync-client';

/**
 * `fetchFull` 与真实 HTTP 的接缝回归（2026-10-29）。
 *
 * 事故形态：服务端按文档返回 `Content-Encoding: br` + brotli 正文
 * （`server/src/sop/sop-sync.controller.ts` 的 `@Header('Content-Encoding','br')`），
 * 而 Node 的 fetch（undici）**会按该头自动解压** ⇒ 客户端拿到的已是明文 JSON，
 * 再 brotli 解一次必然失败 ⇒ 全量同步恒报 `decode_error`，日志写「解压失败」。
 *
 * 之所以长期没被发现：既有用例直接 `new Response(压缩字节)` 构造响应，
 * **没有 Content-Encoding 头**，undici 也就不解压 —— 用例绿、线上红。
 * 本文件专用真实 http 服务复现两种形态，正是为了堵住这个假绿口子。
 */

const RULES = [
  {
    id: 'guard.block.official.fixture',
    domain: 'guard',
    action: 'block',
    status: 'active',
    content: {},
  },
];

let server: http.Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

/** 起一个返回固定字节与响应头的服务；返回基址（含 /sop） */
async function startServer(
  body: Buffer,
  headers: Record<string, string>,
): Promise<string> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, headers).end(body);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/sop`;
}

const jsonBytes = Buffer.from(JSON.stringify(RULES));

describe('SopSyncClient.fetchFull — Content-Encoding 双重解压坑', () => {
  it('Given 响应带 Content-Encoding: br（fetch 会自动解压），Then 仍能取到规则而不是 decode_error', async () => {
    const base = await startServer(zlib.brotliCompressSync(jsonBytes), {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'br',
    });

    const result = await new SopSyncClient(base).fetchFull('1.0.0');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe('guard.block.official.fixture');
  });

  it('Given 响应无 Content-Encoding（正文仍是 brotli 字节），Then 照旧手工解压——旧口径不能被改坏', async () => {
    const base = await startServer(zlib.brotliCompressSync(jsonBytes), {
      'Content-Type': 'application/octet-stream',
    });

    const result = await new SopSyncClient(base).fetchFull('1.0.0');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
  });

  it('Given 正文既不是压缩流也不是 JSON，Then 仍归 decode_error——不能把"解压失败"一律当明文放行', async () => {
    const base = await startServer(Buffer.from('\u0000\u0001 not json'), {
      'Content-Type': 'application/octet-stream',
    });

    const result = await new SopSyncClient(base).fetchFull('1.0.0');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('decode_error');
  });
});
