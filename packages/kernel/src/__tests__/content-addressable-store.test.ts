import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ContentAddressableStore } from '../sop/cache/content-addressable-store';
import { makeRule } from './helpers/rule-factory';

const SHA256_FULL = /^sha256-[0-9a-f]{64}$/;
const SHA256_PREFIX = /^sha256-/;

describe('ContentAddressableStore', () => {
  let baseDir: string;
  let store: ContentAddressableStore;

  beforeEach(() => {
    baseDir = path.join(os.tmpdir(), `zhshield-cas-${crypto.randomUUID()}`);
    fs.mkdirSync(baseDir, { recursive: true });
    store = new ContentAddressableStore(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  // ─── initialize ───────────────────────────────────
  describe('initialize', () => {
    it('应创建 objects 和 manifests 子目录', async () => {
      await store.initialize();
      expect(fs.existsSync(path.join(baseDir, 'objects'))).toBe(true);
      expect(fs.existsSync(path.join(baseDir, 'manifests'))).toBe(true);
    });

    it('重复 initialize 不应报错（recursive: true）', async () => {
      await store.initialize();
      await expect(store.initialize()).resolves.toBeUndefined();
    });
  });

  // ─── storeRule / getRule ──────────────────────────
  describe('storeRule / getRule', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('存储规则应返回 sha256- 前缀的内容哈希 key', async () => {
      const rule = makeRule({ id: 'r-1', name: 'test' });
      const key = await store.storeRule(rule);
      expect(key).toMatch(SHA256_FULL);
    });

    it('相同内容存储两次应返回相同 key 且不重复写入', async () => {
      const rule = makeRule({ id: 'r-1' });
      const key1 = await store.storeRule(rule);
      const key2 = await store.storeRule(rule);
      expect(key1).toBe(key2);
      // objects 目录下只有一个文件
      const files = fs.readdirSync(path.join(baseDir, 'objects'));
      expect(files.length).toBe(1);
    });

    it('内容不同应产生不同 key', async () => {
      const k1 = await store.storeRule(makeRule({ id: 'r-1' }));
      const k2 = await store.storeRule(makeRule({ id: 'r-2' }));
      expect(k1).not.toBe(k2);
    });

    it('getRule 应还原存储的规则', async () => {
      const rule = makeRule({ id: 'r-1', name: 'hello', severity: 'high' });
      const key = await store.storeRule(rule);
      const restored = await store.getRule(key);
      expect(restored).not.toBeNull();
      expect(restored?.id).toBe('r-1');
      expect(restored?.name).toBe('hello');
      expect(restored?.severity).toBe('high');
    });

    it('getRule 不存在的 key 应返回 null', async () => {
      expect(await store.getRule('sha256-nonexistent')).toBeNull();
    });

    it('exists 应正确反映内容是否存在', async () => {
      const key = await store.storeRule(makeRule({ id: 'r-1' }));
      expect(await store.exists(key)).toBe(true);
      expect(await store.exists('sha256-nope')).toBe(false);
    });
  });

  // ─── storeRules / getRules 批量 ──────────────────
  describe('storeRules / getRules', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('storeRules 应返回 ruleId → hashKey 的映射', async () => {
      const rules = [makeRule({ id: 'r-1' }), makeRule({ id: 'r-2' })];
      const keyMap = await store.storeRules(rules);
      expect(keyMap.size).toBe(2);
      expect(keyMap.get('r-1')).toMatch(SHA256_PREFIX);
      expect(keyMap.get('r-2')).toMatch(SHA256_PREFIX);
    });

    it('getRules 应批量还原规则（跳过不存在的 key）', async () => {
      const rules = [makeRule({ id: 'r-1' }), makeRule({ id: 'r-2' })];
      const keyMap = await store.storeRules(rules);
      const keys = [...keyMap.values()];
      keys.push('sha256-missing'); // 一个不存在的 key
      const restored = await store.getRules(keys);
      expect(restored.length).toBe(2); // 跳过 missing
      const ids = restored.map((r) => r.id).sort();
      expect(ids).toEqual(['r-1', 'r-2']);
    });
  });

  // ─── 版本清单 manifest ───────────────────────────
  describe('saveManifest / loadManifest', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('saveManifest 后 loadManifest 应还原 ruleId → hashKey 映射', async () => {
      const keyMap = new Map<string, string>([
        ['r-1', 'sha256-aaa'],
        ['r-2', 'sha256-bbb'],
      ]);
      await store.saveManifest('v1', keyMap);
      const loaded = await store.loadManifest('v1');
      expect(loaded).not.toBeNull();
      expect(loaded?.get('r-1')).toBe('sha256-aaa');
      expect(loaded?.get('r-2')).toBe('sha256-bbb');
    });

    it('loadManifest 不存在的版本应返回 null', async () => {
      expect(await store.loadManifest('v-nonexistent')).toBeNull();
    });

    it('manifest 文件应包含 version 与 createdAt 字段', async () => {
      await store.saveManifest('v1', new Map([['r-1', 'sha256-aaa']]));
      const raw = fs.readFileSync(path.join(baseDir, 'manifests', 'v1.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe('v1');
      expect(parsed.createdAt).toBeTruthy();
      expect(parsed.rules).toEqual({ 'r-1': 'sha256-aaa' });
    });
  });

  // ─── diffVersions ────────────────────────────────
  describe('diffVersions', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('应正确分类新增/删除/修改/未变化', async () => {
      // v1: r-1, r-2, r-3
      await store.saveManifest(
        'v1',
        new Map([
          ['r-1', 'h-1'],
          ['r-2', 'h-2'],
          ['r-3', 'h-3'],
        ]),
      );
      // v2: r-2(改), r-3(不变), r-4(新增)；r-1 删除
      await store.saveManifest(
        'v2',
        new Map([
          ['r-2', 'h-2-modified'],
          ['r-3', 'h-3'],
          ['r-4', 'h-4'],
        ]),
      );

      const diff = await store.diffVersions('v1', 'v2');
      expect(diff.added).toEqual(['r-4']);
      expect(diff.removed).toEqual(['r-1']);
      expect(diff.modified).toEqual(['r-2']);
      expect(diff.unchanged).toEqual(['r-3']);
    });

    it('任一 manifest 不存在应抛出错误', async () => {
      await store.saveManifest('v1', new Map([['r-1', 'h-1']]));
      await expect(store.diffVersions('v1', 'v-missing')).rejects.toThrow(
        'Version manifest not found',
      );
    });

    it('完全相同的两个版本应全部 unchanged', async () => {
      const m = new Map([
        ['r-1', 'h-1'],
        ['r-2', 'h-2'],
      ]);
      await store.saveManifest('v1', m);
      await store.saveManifest('v2', m);
      const diff = await store.diffVersions('v1', 'v2');
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.modified).toEqual([]);
      expect(diff.unchanged.sort()).toEqual(['r-1', 'r-2']);
    });
  });

  // ─── getStorageStats ─────────────────────────────
  describe('getStorageStats', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('空存储应返回零计数', async () => {
      const stats = await store.getStorageStats();
      expect(stats.totalObjects).toBe(0);
      expect(stats.totalSizeBytes).toBe(0);
      expect(stats.dedupSavingsPercent).toBe(0);
    });

    it('存储对象后应正确统计数量与大小', async () => {
      await store.storeRule(makeRule({ id: 'r-1' }));
      await store.storeRule(makeRule({ id: 'r-2' }));
      const stats = await store.getStorageStats();
      expect(stats.totalObjects).toBe(2);
      expect(stats.totalSizeBytes).toBeGreaterThan(0);
    });

    it('单一 manifest 时去重收益应为 0（需 >1 个 manifest 才计算）', async () => {
      await store.storeRule(makeRule({ id: 'r-1' }));
      await store.saveManifest('v1', new Map([['r-1', 'sha256-x']]));
      const stats = await store.getStorageStats();
      expect(stats.dedupSavingsPercent).toBe(0);
    });

    it('多版本共享对象时应计算出去重收益百分比', async () => {
      // 同一规则在两个版本中引用同一 hash → 去重
      const rule = makeRule({ id: 'r-1' });
      const key = await store.storeRule(rule);
      await store.saveManifest('v1', new Map([['r-1', key]]));
      await store.saveManifest('v2', new Map([['r-1', key]]));

      const stats = await store.getStorageStats();
      // totalRuleRefs=2, objectCount=1 → (2-1)/2 = 50%
      expect(stats.dedupSavingsPercent).toBe(50);
    });
  });
});
