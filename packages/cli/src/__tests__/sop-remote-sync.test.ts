import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { groupByDomain, readSyncMeta, syncRulesFromCloud } from '../sop-remote-sync';
import { generateKeyPair, makeGateRule, makeRule, startFakeCloud } from './sop-fake-cloud';
import type { FakeCloud } from './sop-fake-cloud';

/**
 * 云端规则同步的行为契约。
 *
 * 这一层的每条断言都对应一种「同步了但门禁没变」的失真：
 *   · 落盘位置/格式不对 → 扫描引擎读不到 → 门禁仍是 0 条；
 *   · 空包也覆盖 → 好规则被「什么都没查」替换，且从"未判定"退化成"合法无门禁"；
 *   · 验签失败还写盘 → 中毒规则进缓存，之后每次扫描都按它判；
 *   · 失败时破坏旧缓存 → 一次网络抖动让门禁能力永久消失。
 */

let tmpRoot: string;
let clouds: FakeCloud[];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-sop-remote-'));
  clouds = [];
});

afterEach(async () => {
  for (const cloud of clouds) await cloud.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function startCloud(options: Parameters<typeof startFakeCloud>[0]): Promise<FakeCloud> {
  const cloud = await startFakeCloud(options);
  clouds.push(cloud);
  return cloud;
}

function targetDir(name = 'cache'): string {
  return path.join(tmpRoot, name);
}

/** 断言缓存里没有任何规则目录（失败路径不该留下半份） */
function expectNoCache(dir: string): void {
  expect(fs.existsSync(path.join(dir, 'modules'))).toBe(false);
}

/** 造一份「已有可用缓存」，用来验证失败时不被破坏 */
function seedCache(dir: string): void {
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'modules', 'guard.db'), '[{"id":"old"}]', 'utf-8');
}

describe('syncRulesFromCloud — 正常路径', () => {
  it('Given 服务端签名包，When 同步，Then 按 domain 落盘 modules/*.db 并写元信息', async () => {
    const keys = generateKeyPair();
    const cloud = await startCloud({
      rules: [makeRule({ domain: 'guard' }), makeRule({ domain: 'security' })],
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });

    const result = await syncRulesFromCloud({
      sopBase: cloud.base,
      targetDir: targetDir(),
      publicKey: keys.publicKeyPem,
      allowUnsigned: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signed).toBe(true);
    expect(result.ruleCount).toBe(2);
    expect(result.domains).toEqual(['guard', 'security']);

    const modules = path.join(targetDir(), 'modules');
    expect(fs.readdirSync(modules).sort()).toEqual(['guard.db', 'security.db']);
    const parsed = JSON.parse(fs.readFileSync(path.join(modules, 'guard.db'), 'utf-8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);

    const meta = readSyncMeta(targetDir());
    expect(meta?.version).toBe('1.2026.10.29.001');
    expect(meta?.ruleCount).toBe(2);
    expect(meta?.signed).toBe(true);
  });

  it('Given 规则含门禁规则，When 同步，Then 元信息记下门禁条数——同步成功但门禁为 0 必须能被看出', async () => {
    const keys = generateKeyPair();
    const cloud = await startCloud({
      rules: [makeRule(), makeGateRule()],
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });

    const result = await syncRulesFromCloud({
      sopBase: cloud.base,
      targetDir: targetDir(),
      publicKey: keys.publicKeyPem,
      allowUnsigned: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gateCount).toBe(1);
    expect(readSyncMeta(targetDir())?.gateCount).toBe(1);
  });

  it('Given 已有旧缓存，When 同步新版，Then 整体替换且不留临时目录', async () => {
    const keys = generateKeyPair();
    const dir = targetDir();
    seedCache(dir);
    const cloud = await startCloud({
      rules: [makeRule(), makeRule()],
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });

    const result = await syncRulesFromCloud({
      sopBase: cloud.base,
      targetDir: dir,
      publicKey: keys.publicKeyPem,
      allowUnsigned: false,
    });

    expect(result.ok).toBe(true);
    const entries = fs.readdirSync(dir).filter((name) => name.startsWith('.modules-tmp-'));
    expect(entries).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'modules', 'guard.db'))).toBe(true);
  });
});

describe('syncRulesFromCloud — 失败必须拒收且不破坏现状', () => {
  it('Given 服务端只回裸规则数组且未开 allowUnsigned，Then 验签阶段拒收，一个文件都不写', async () => {
    const keys = generateKeyPair();
    const cloud = await startCloud({
      rules: [makeRule()],
      publicKeyPem: keys.publicKeyPem,
    });

    const result = await syncRulesFromCloud({
      sopBase: cloud.base,
      targetDir: targetDir(),
      publicKey: keys.publicKeyPem,
      allowUnsigned: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('verify');
    expectNoCache(targetDir());
  });

  it('Given 公钥与服务端私钥不匹配，Then signature_rejected 且旧缓存原样保留', async () => {
    const serverKeys = generateKeyPair();
    const otherKeys = generateKeyPair();
    const dir = targetDir();
    seedCache(dir);
    const cloud = await startCloud({
      rules: [makeRule()],
      privateKeyPem: serverKeys.privateKeyPem,
      publicKeyPem: serverKeys.publicKeyPem,
    });

    const result = await syncRulesFromCloud({
      sopBase: cloud.base,
      targetDir: dir,
      publicKey: otherKeys.publicKeyPem,
      allowUnsigned: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('verify');
    expect(fs.readFileSync(path.join(dir, 'modules', 'guard.db'), 'utf-8')).toContain('old');
  });

  it('Given 云端返回 0 条规则，Then 判 empty 且不覆盖本地缓存——空集不得替换好规则', async () => {
    const keys = generateKeyPair();
    const dir = targetDir();
    seedCache(dir);
    const cloud = await startCloud({
      rules: [],
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });

    const result = await syncRulesFromCloud({
      sopBase: cloud.base,
      targetDir: dir,
      publicKey: keys.publicKeyPem,
      allowUnsigned: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('empty');
    expect(fs.readFileSync(path.join(dir, 'modules', 'guard.db'), 'utf-8')).toContain('old');
  });

  it('Given 无公钥且未开 allowUnsigned，Then 在下载前就失败于 public-key 阶段——别等下载完再说验签失败', async () => {
    const cloud = await startCloud({ rules: [makeRule()], publicKeyPem: null });

    const result = await syncRulesFromCloud({
      sopBase: cloud.base,
      targetDir: targetDir(),
      allowUnsigned: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('public-key');
    // 版本接口没被调用：公钥都拿不到，不必再问版本
    expect(cloud.requests).not.toContain('/sop/version');
    expectNoCache(targetDir());
  });

  it('Given 服务端 /full 返回 500，Then 归因到下载阶段并保留旧缓存', async () => {
    const keys = generateKeyPair();
    const dir = targetDir();
    seedCache(dir);
    const cloud = await startCloud({
      rules: [makeRule()],
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
      fullStatus: 500,
    });

    const result = await syncRulesFromCloud({
      sopBase: cloud.base,
      targetDir: dir,
      publicKey: keys.publicKeyPem,
      allowUnsigned: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('download');
    expect(result.detail).toContain('500');
    expect(fs.existsSync(path.join(dir, 'modules', 'guard.db'))).toBe(true);
  });
});

describe('syncRulesFromCloud — allowUnsigned 逃生口', () => {
  it('Given 显式 allowUnsigned，When 服务端只回裸数组，Then 放行但结果标记 signed=false', async () => {
    const cloud = await startCloud({ rules: [makeRule()], publicKeyPem: null });

    const result = await syncRulesFromCloud({
      sopBase: cloud.base,
      targetDir: targetDir(),
      allowUnsigned: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signed).toBe(false);
    expect(result.ruleCount).toBe(1);
  });
});

describe('groupByDomain — 网络来的字符串要当文件名用', () => {
  it('Given domain 含路径穿越片段，Then 归入 unknown 而不是写出到 modules 之外', () => {
    const evil = makeRule({ domain: '../evil' as never });
    const grouped = groupByDomain([evil, makeRule({ domain: 'guard' })]);
    expect([...grouped.keys()].sort()).toEqual(['guard', 'unknown']);
  });

  it('Given 同一 domain 多条，Then 落在同一个桶里', () => {
    const grouped = groupByDomain([makeRule({ domain: 'guard' }), makeRule({ domain: 'guard' })]);
    expect(grouped.get('guard')).toHaveLength(2);
  });
});

describe('readSyncMeta — 读不到不是错误', () => {
  it('Given 目录不存在，Then 返回 undefined 而非抛错', () => {
    expect(readSyncMeta(path.join(tmpRoot, 'nope'))).toBeUndefined();
  });

  it('Given 元信息被截断，Then 返回 undefined——损坏的元信息不该让同步链崩掉', () => {
    const dir = targetDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sync-meta.json'), '{ broken', 'utf-8');
    expect(readSyncMeta(dir)).toBeUndefined();
  });
});
