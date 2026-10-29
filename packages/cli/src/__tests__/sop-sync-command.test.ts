import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runSopSyncCommand } from '../sop-sync-command';
import type { SopSyncCommandInput } from '../sop-sync-command';
import { resolveSopRemoteSettings } from '../sop-remote-config';
import type { SopRemoteSettings } from '../sop-remote-config';
import { generateKeyPair, makeGateRule, makeRule, startFakeCloud } from './sop-fake-cloud';
import type { FakeCloud } from './sop-fake-cloud';

/**
 * `sop sync` 命令输出契约。
 *
 * 断言重点不是"打印了字"，而是**四个必须被看见的事实**：
 *   ① 连的是哪个云（配错 ZH_API_BASE 时最容易白跑一场）
 *   ② 令牌与公钥从哪来（CI 里 secret 没注入，看输出就够）
 *   ③ 规则落到哪（否则"同步成功但扫描没变"无从排查）
 *   ④ 本次规则集里有没有门禁规则（同步成功 ≠ 门禁有结论）
 */

let tmpRoot: string;
let home: string;
let clouds: FakeCloud[];
let logs: string[];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-sop-cmd-'));
  home = path.join(tmpRoot, 'home');
  fs.mkdirSync(home, { recursive: true });
  clouds = [];
  logs = [];
});

afterEach(async () => {
  for (const cloud of clouds) await cloud.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const log = (line: string): void => {
  logs.push(line);
};

function settingsFor(base: string, overrides: Partial<SopRemoteSettings> = {}): SopRemoteSettings {
  return {
    sopBase: base,
    tokenSource: '未提供（test）',
    publicKeySource: 'ZH_SOP_PUBLIC_KEY',
    allowUnsigned: false,
    problems: [],
    ...overrides,
  };
}

function inputFor(
  settings: SopRemoteSettings,
  cacheEnv: { env: NodeJS.ProcessEnv } = { env: {} },
): SopSyncCommandInput {
  return {
    settings,
    cacheEnv: { env: cacheEnv.env, platform: 'darwin', homeDir: home },
  };
}

async function startCloud(options: Parameters<typeof startFakeCloud>[0]): Promise<FakeCloud> {
  const cloud = await startFakeCloud(options);
  clouds.push(cloud);
  return cloud;
}

describe('runSopSyncCommand — 成功路径', () => {
  it('Given 签名包，When 同步，Then 退出码 0 且输出含版本/条数/门禁条数/落点', async () => {
    const keys = generateKeyPair();
    const cloud = await startCloud({
      rules: [makeRule(), makeGateRule()],
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });

    const code = await runSopSyncCommand(
      inputFor(settingsFor(cloud.base, { publicKey: keys.publicKeyPem })),
      log,
    );

    expect(code).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain(cloud.base);
    expect(text).toContain('1.2026.10.29.001');
    expect(text).toContain('2 条规则');
    expect(text).toContain('门禁 1 条');
    expect(text).toContain(path.join(home, '.zhshield', 'sop-cache'));
    expect(text).toContain('ZH_GATE_REQUIRE_SOP=1');
  });

  it('Given 本地已有版本，When 同步新版本，Then 输出说明版本变化——否则无法判断这次到底拉到没有', async () => {
    const keys = generateKeyPair();
    const dir = path.join(home, '.zhshield', 'sop-cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'sync-meta.json'),
      JSON.stringify({ version: '1.2026.10.01.001' }),
      'utf-8',
    );
    const cloud = await startCloud({
      rules: [makeRule()],
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });

    await runSopSyncCommand(inputFor(settingsFor(cloud.base, { publicKey: keys.publicKeyPem })), log);

    expect(logs.join('\n')).toContain('由 1.2026.10.01.001 更新');
  });

  it('Given 规则集不含门禁规则，Then 明确警告「同步成功但门禁无结论」——别让人把绿灯当门禁通过', async () => {
    const keys = generateKeyPair();
    const cloud = await startCloud({
      rules: [makeRule()],
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });

    await runSopSyncCommand(inputFor(settingsFor(cloud.base, { publicKey: keys.publicKeyPem })), log);

    expect(logs.join('\n')).toContain('不含扫描后门禁规则');
  });

  it('Given 显式 ZH_SOP_CACHE_DIR，Then 规则落到该目录而不是默认 HOME 位置', async () => {
    const keys = generateKeyPair();
    const explicit = path.join(tmpRoot, 'ci-cache');
    const cloud = await startCloud({
      rules: [makeRule()],
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });

    const code = await runSopSyncCommand(
      inputFor(settingsFor(cloud.base, { publicKey: keys.publicKeyPem }), {
        env: { ZH_SOP_CACHE_DIR: explicit },
      }),
      log,
    );

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(explicit, 'modules'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.zhshield', 'sop-cache'))).toBe(false);
  });
});

describe('runSopSyncCommand — 失败路径', () => {
  it('Given 拿不到公钥，Then 退出码 2 且输出把阶段说成人话并声明未写入', async () => {
    const cloud = await startCloud({ rules: [makeRule()], publicKeyPem: null });

    const code = await runSopSyncCommand(inputFor(settingsFor(cloud.base)), log);

    expect(code).toBe(2);
    const text = logs.join('\n');
    expect(text).toContain('验签公钥');
    expect(text).toContain('未写入任何规则');
  });

  it('Given 验签不通过，Then 退出码 2 且明确提示「可能被篡改或公钥不匹配」', async () => {
    const serverKeys = generateKeyPair();
    const otherKeys = generateKeyPair();
    const cloud = await startCloud({
      rules: [makeRule()],
      privateKeyPem: serverKeys.privateKeyPem,
      publicKeyPem: serverKeys.publicKeyPem,
    });

    const code = await runSopSyncCommand(
      inputFor(settingsFor(cloud.base, { publicKey: otherKeys.publicKeyPem })),
      log,
    );

    expect(code).toBe(2);
    expect(logs.join('\n')).toContain('公钥与服务端不匹配');
  });

  it('Given 配置有 problems，Then 先打警告再继续——公钥文件写错要先看见，而不是等失败再猜', async () => {
    const keys = generateKeyPair();
    const cloud = await startCloud({
      rules: [makeRule()],
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });

    await runSopSyncCommand(
      inputFor(
        settingsFor(cloud.base, {
          publicKey: keys.publicKeyPem,
          problems: ['ZH_SOP_PUBLIC_KEY 指向的文件不含 PEM 公钥: /x.pem'],
        }),
      ),
      log,
    );

    expect(logs.join('\n')).toContain('不含 PEM 公钥');
  });
});

describe('运行环境到配置的默认接线', () => {
  it('Given 空环境，Then 默认 allowUnsigned=false——CI 的信任边界不能默认 fail-open', () => {
    const settings = resolveSopRemoteSettings({ env: {}, homeDir: home });
    expect(settings.allowUnsigned).toBe(false);
  });
});
