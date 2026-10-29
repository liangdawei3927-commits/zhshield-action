import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SOP_PUBLIC_KEY_ENV,
  SOP_TOKEN_ENV,
  readCloudToken,
  resolvePublicKeyMaterial,
  resolveSopRemoteSettings,
} from '../sop-remote-config';
import { generateKeyPair } from './sop-fake-cloud';

/**
 * 同步入口参数解析的契约。
 *
 * 这一层的失真方向很特别：**配错不是报错，而是静默换了来源**。
 *   · 令牌没读到 → 服务端 401（能看见）
 *   · 公钥没读到 → 若默认放行就成了永远绿灯（看不见）
 *   · 路径写成相对路径 → 按 HOME 展开后读不到，却仍报"已配置"
 * 所以断言集中在「来源说明是否说了真话」。
 */

let tmpRoot: string;
let home: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-sop-config-'));
  home = path.join(tmpRoot, 'home');
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('readCloudToken — 只读，不凭空生成', () => {
  it('Given 环境变量有令牌，Then 优先用它并标明来源', () => {
    const result = readCloudToken({ env: { [SOP_TOKEN_ENV]: ' abc ' }, homeDir: home });
    expect(result.token).toBe('abc');
    expect(result.source).toContain(SOP_TOKEN_ENV);
  });

  it('Given 只有令牌文件，Then 读出内容且不改写文件', () => {
    const dir = path.join(home, '.zhshield');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '.api-token');
    fs.writeFileSync(file, 'from-file\n', 'utf-8');

    const result = readCloudToken({ env: {}, homeDir: home });
    expect(result.token).toBe('from-file');
    expect(fs.readFileSync(file, 'utf-8')).toBe('from-file\n');
  });

  it('Given 两者都没有，Then 不给令牌且来源说清两个位置——CI 里 401 时要能一眼看出 secret 没注入', () => {
    const result = readCloudToken({ env: {}, homeDir: home });
    expect(result.token).toBeUndefined();
    expect(result.source).toContain(SOP_TOKEN_ENV);
    expect(result.source).toContain('.api-token');
    expect(fs.existsSync(path.join(home, '.zhshield', '.api-token'))).toBe(false);
  });
});

describe('resolvePublicKeyMaterial — PEM 字面量 vs 文件路径', () => {
  it('Given 环境里直接塞了 PEM 字面量（含换行），Then 按字面量用，不当路径读盘', () => {
    const keys = generateKeyPair();
    const result = resolvePublicKeyMaterial(keys.publicKeyPem, home);
    expect(result.key).toBe(keys.publicKeyPem.trim());
    expect(result.problem).toBeUndefined();
  });

  it('Given 绝对路径指向 PEM 文件，Then 读出公钥', () => {
    const keys = generateKeyPair();
    const file = path.join(tmpRoot, 'pub.pem');
    fs.writeFileSync(file, keys.publicKeyPem, 'utf-8');

    const result = resolvePublicKeyMaterial(file, home);
    expect(result.key).toContain('BEGIN PUBLIC KEY');
  });

  it('Given 相对路径，Then 按 HOME 展开——CI 里写 ./keys/pub.pem 不该解析到进程 cwd', () => {
    const keys = generateKeyPair();
    fs.mkdirSync(path.join(home, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(home, 'keys', 'pub.pem'), keys.publicKeyPem, 'utf-8');

    const result = resolvePublicKeyMaterial('keys/pub.pem', home);
    expect(result.key).toContain('BEGIN PUBLIC KEY');
  });

  it('Given 文件存在但不是 PEM，Then 报问题而不是把它当公钥用——错内容比缺内容更难查', () => {
    const file = path.join(tmpRoot, 'not-a-key.pem');
    fs.writeFileSync(file, 'hello', 'utf-8');

    const result = resolvePublicKeyMaterial(file, home);
    expect(result.key).toBeUndefined();
    expect(result.problem).toContain('不含 PEM 公钥');
  });

  it('Given 路径不存在，Then 报问题并带上路径', () => {
    const missing = path.join(tmpRoot, 'missing.pem');
    const result = resolvePublicKeyMaterial(missing, home);
    expect(result.problem).toContain(missing);
  });
});

describe('resolveSopRemoteSettings — 汇总与默认值', () => {
  it('Given 什么都没配，Then allowUnsigned 默认 false 且公钥来源说明会去服务端取', () => {
    const settings = resolveSopRemoteSettings({ env: {}, homeDir: home });
    expect(settings.allowUnsigned).toBe(false);
    expect(settings.publicKey).toBeUndefined();
    expect(settings.publicKeySource).toContain('/sop/public-key');
    expect(settings.problems).toEqual([]);
    expect(settings.sopBase.endsWith('/sop')).toBe(true);
  });

  it('Given 配了公钥文件却不存在，Then 进 problems——继续跑会失败，但要先告诉人为什么', () => {
    const settings = resolveSopRemoteSettings({
      env: { [SOP_PUBLIC_KEY_ENV]: path.join(tmpRoot, 'nope.pem') },
      homeDir: home,
    });
    expect(settings.publicKey).toBeUndefined();
    expect(settings.problems).toHaveLength(1);
  });

  it.each(['1', 'true', 'YES', 'on'])('Given ZH_SOP_ALLOW_UNSIGNED=%s，Then allowUnsigned 为真', (raw) => {
    const settings = resolveSopRemoteSettings({
      env: { ZH_SOP_ALLOW_UNSIGNED: raw },
      homeDir: home,
    });
    expect(settings.allowUnsigned).toBe(true);
  });

  it.each(['0', 'false', '', 'off'])('Given ZH_SOP_ALLOW_UNSIGNED=%s，Then allowUnsigned 为假', (raw) => {
    const settings = resolveSopRemoteSettings({
      env: { ZH_SOP_ALLOW_UNSIGNED: raw },
      homeDir: home,
    });
    expect(settings.allowUnsigned).toBe(false);
  });
});
