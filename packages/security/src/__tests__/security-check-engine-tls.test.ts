import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SecurityCheckEngine } from '../security-check-engine';

/**
 * TLS 配置检测（ASVS 9.1）的验收用例。
 *
 * 锁定的不变量：
 *   1. 显式关闭证书校验 / 弱协议 / 弱套件 → failed，并指出文件行号；
 *   2. 干净配置 → passed，但文案必须写明「源码模式、不覆盖运行期/部署侧」——
 *      0 命中不等于传输加密已合规（C4：未检测 ≠ 通过）；
 *   3. 引擎自身实现文件不自匹配（正则定义行不得被当作被检项目的缺陷）。
 */
describe('SecurityCheckEngine — TLS 配置检测', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'zh-security-tls-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  async function runChecks(checks: string[]) {
    const { results } = await new SecurityCheckEngine().run({
      mode: 'security',
      target: dir,
      checks,
      dryRun: false,
    });
    return results;
  }

  it('关闭证书校验 → tls-verification-disabled 失败并给出行号', async () => {
    write(
      'src/http-client.ts',
      ['import https from "node:https";', 'https.request(url, { rejectUnauthorized: false });'].join(
        '\n',
      ),
    );
    const [result] = await runChecks(['tls-verification-disabled']);

    expect(result.status).toBe('failed');
    // 行号指向违规行，而不是文件名泛泛而谈
    expect(result.message).toContain('src/http-client.ts:2');
  });

  it('环境变量关闭校验同样命中', async () => {
    write('src/bootstrap.ts', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';");
    const [result] = await runChecks(['tls-verification-disabled']);

    expect(result.status).toBe('failed');
    expect(result.message).toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });

  it('弱协议（minVersion TLSv1.1）→ weak-tls-protocol 失败', async () => {
    write(
      'src/server.ts',
      ['import https from "node:https";', 'https.createServer({ minVersion: "TLSv1.1" });'].join('\n'),
    );
    const [result] = await runChecks(['weak-tls-protocol']);

    expect(result.status).toBe('failed');
    expect(result.message).toContain('src/server.ts:2');
  });

  it('强 TLS 配置（TLSv1.2+）→ 通过，且文案不冒充「传输加密已合规」', async () => {
    write(
      'src/server.ts',
      ['import https from "node:https";', 'https.createServer({ minVersion: "TLSv1.2" });'].join('\n'),
    );
    const [result] = await runChecks(['weak-tls-protocol', 'tls-verification-disabled']);

    expect(result.status).toBe('passed');
    // 诚实边界：源码模式检测不覆盖运行期/部署侧配置
    expect(result.message).toContain('不覆盖运行期/部署侧配置');
    expect(result.message).not.toContain('已合规');
  });

  it('引擎自身实现文件（正则定义行）不被当作被检项目的缺陷', async () => {
    // 文件名与引擎实现同名：其内容里的模式写法必须被排除，否则自匹配成伪证据
    write(
      'src/security-check-engine.ts',
      'const RE = /rejectUnauthorized\\s*:\\s*false/;',
    );
    const [result] = await runChecks(['tls-verification-disabled']);

    expect(result.status).toBe('passed');
  });
});
