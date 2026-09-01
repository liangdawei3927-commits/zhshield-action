/**
 * download.mjs — 下载链与校验
 *
 * 下载兜底顺序: fetch（重试）→ https.request → curl。
 * GitHub CDN 会拒绝 undici 默认 UA，所有请求必须带 User-Agent。
 *
 * 依赖: 仅 node 内置模块（node:fs/node:https/node:http/node:crypto/
 *        node:child_process），node 20+。
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
import { warn } from './constants.mjs';

/** 换行符（\r?\n），模块级常量避免每次调用重编译 */
const RE_NEWLINE = /\r?\n/;

/** 空白字符（空格、制表符等），模块级常量避免每次调用重编译 */
const RE_WHITESPACE = /\s+/;

/** 下载文件到本地（GitHub CDN 会拒绝 undici 默认 UA，必须带 User-Agent） */
export async function downloadFile(url, dest) {
  const buf = await downloadBuffer(url);
  writeFileSync(dest, buf);
}

/** 下载字节：fetch（重试）→ https.request → curl 兜底 */
export async function downloadBuffer(url) {
  try {
    return await fetchWithRetry(url);
  } catch (e) {
    warn(`fetch 失败（${e.message}），改用 https.request 下载`);
  }
  try {
    return await httpRequest(url);
  } catch (e) {
    warn(`https.request 失败（${e.message}），改用 curl 下载`);
  }
  return curlDownload(url);
}

/** curl 下载（本机网络对 Node HTTP 栈不稳定，curl 最可靠） */
export function curlDownload(url) {
  const res = spawnSync('curl', ['-fsSL', '--max-time', '300', url], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`curl 下载失败（exit ${res.status}）: ${(res.stderr || '').toString().trim()}`);
  }
  return res.stdout;
}

/** fetch + 重试（本机网络对 github.com 连接不稳定，undici 10s 连接超时偏短） */
export async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'zhshield-install/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 经典 https.request 下载（跟随重定向），作为 fetch 的兜底 */
export function httpRequest(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? httpsGet : httpGet;
    const req = mod(url, { headers: { 'User-Agent': 'zhshield-install/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        httpRequest(next, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}: ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('请求超时')));
  });
}

/** 计算文件 sha256 */
export function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** 从官方 checksum 文件中解析目标文件的 sha256（格式: <hash>  <filename>） */
export function parseChecksum(text, fileName) {
  for (const line of text.split(RE_NEWLINE)) {
    const parts = line.trim().split(RE_WHITESPACE);
    if (parts.length >= 2 && parts[1] === fileName) return parts[0];
  }
  return null;
}
