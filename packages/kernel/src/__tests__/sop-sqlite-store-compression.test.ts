import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SmartCompressor } from '../sop/smart-compressor';
import { SopSqliteStore } from '../sop/cache/sop-sqlite-store';
import { SopCacheManager } from '../sop/cache/sop-cache-manager';
import { SopRegistry } from '../sop/_meta/sop-registry';
import type { SopDiff, SopRule } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

const UNKNOWN_STRATEGY_RE = /Unknown compression strategy/;

class SpyCompressor extends SmartCompressor {
  compressCalls = 0;

  compress(data: string): ReturnType<SmartCompressor['compress']> {
    this.compressCalls += 1;
    return super.compress(data);
  }
}

function bigRule(id: string): SopRule {
  return makeRule({ id, content: { script: 'x'.repeat(400), engine: 'semgrep' } });
}

function makeDiff(added: SopRule[]): SopDiff {
  return {
    version: '1.2026.08.22.001',
    fromVersion: '0.0.0',
    compatibility: '>=0.1.0',
    added,
    removed: [],
    modified: [],
    unchanged: [],
    metadata: { totalRules: added.length, diffSize: 0, hash: '' },
  };
}

describe('SmartCompressor（策略选择 API）', () => {
  const compressor = new SmartCompressor();

  it('GIVEN 大体积 pretty JSON WHEN compress THEN 选择 json-minify 且体积缩小', () => {
    const pretty = JSON.stringify({ rules: [{ id: 'r1', description: 'x'.repeat(300) }] }, null, 2);
    const result = compressor.compress(pretty);

    expect(result.strategy).toBe('json-minify');
    expect(result.originalSize).toBe(pretty.length);
    expect(result.compressedSize).toBeLessThan(result.originalSize);
  });

  it('GIVEN 压缩结果 WHEN decompress THEN 还原为等价对象', () => {
    const source = { id: 'r1', nested: { list: [1, 2, 3], flag: true } };
    const compressed = compressor.compress(JSON.stringify(source));
    const restored: unknown = JSON.parse(compressor.decompress(compressed));

    expect(restored).toEqual(source);
  });

  it('GIVEN 小于 minSize 的数据 WHEN compress THEN 按默认策略处理（不丢弃）', () => {
    const result = compressor.compress('{"a":1}');

    expect(result.strategy).toBe('json-minify');
    expect(JSON.parse(result.data)).toEqual({ a: 1 });
  });

  it('GIVEN 未知策略标记 WHEN decompress THEN 抛出异常', () => {
    expect(() =>
      compressor.decompress({ strategy: 'nope', originalSize: 1, compressedSize: 1, data: '{}' }),
    ).toThrow(UNKNOWN_STRATEGY_RE);
  });
});

describe('SopSqliteStore 压缩存储接入（SmartCompressor）', () => {
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = path.join(os.tmpdir(), `zhshield-compress-${crypto.randomUUID()}`);
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'rules.db');
  });

  afterEach(() => {
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('GIVEN 启用压缩的 store WHEN persist 大规则 THEN 走压缩且读回无损', () => {
    const spy = new SpyCompressor();
    const store = new SopSqliteStore(dbPath, { compressor: spy });
    store.initialize();

    const rule = bigRule('guard.big');
    store.persist([rule]);

    expect(spy.compressCalls).toBe(1);

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe('guard.big');
    expect(loaded[0]?.content).toEqual(rule.content);
    expect(loaded[0]?.severity).toBe(rule.severity);

    const byDomain = store.loadByDomain('guard');
    expect(byDomain).toHaveLength(1);
    expect(byDomain[0]?.id).toBe('guard.big');
  });

  it('GIVEN 未启用压缩的 store WHEN persist THEN 不触发压缩且读写正常', () => {
    const store = new SopSqliteStore(dbPath);
    store.initialize();

    store.persist([makeRule({ id: 'guard.plain' })]);

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe('guard.plain');
  });

  it('GIVEN 历史明文行 WHEN 压缩版 store 读取 THEN 向后兼容直接解析', () => {
    const legacy = new SopSqliteStore(dbPath);
    legacy.initialize();
    legacy.persist([makeRule({ id: 'guard.legacy' })]);

    const upgraded = new SopSqliteStore(dbPath, { compressor: new SmartCompressor() });
    upgraded.initialize();

    const loaded = upgraded.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe('guard.legacy');
  });

  it('GIVEN remove WHEN 按 ID 删除 THEN 仅删除目标行；未初始化时空实现不抛错', () => {
    const store = new SopSqliteStore(dbPath, { compressor: new SmartCompressor() });

    expect(() => store.remove(['guard.x'])).not.toThrow();

    store.initialize();
    store.persist([makeRule({ id: 'guard.keep' }), makeRule({ id: 'guard.drop' })]);
    store.remove(['guard.drop']);

    const ids = store.loadAll().map((r) => r.id);
    expect(ids).toEqual(['guard.keep']);
    expect(() => store.remove([])).not.toThrow();
  });
});

describe('SopCacheManager 压缩链路端到端', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zh-cache-compress-${crypto.randomUUID()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('GIVEN 规则经 applyDiff 落盘 WHEN 新实例初始化 THEN 从压缩行还原规则', async () => {
    const writer = new SopCacheManager(new SopRegistry(), { cacheDir });
    await writer.initialize();
    await writer.applyDiff(makeDiff([bigRule('guard.persisted')]));

    const readerRegistry = new SopRegistry();
    const reader = new SopCacheManager(readerRegistry, { cacheDir });
    await reader.initialize();

    const restored = readerRegistry.get('guard.persisted');
    expect(restored).toBeDefined();
    expect(restored?.content).toEqual(bigRule('guard.persisted').content);
  });
});
