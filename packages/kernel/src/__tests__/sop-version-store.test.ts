import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SopVersionStore } from '../sop/cache/sop-version-store';
import type { SopVersion } from '../sop/_meta/sop-types';

describe('SopVersionStore', () => {
  let cacheDir: string;
  let store: SopVersionStore;

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zhshield-vstore-${crypto.randomUUID()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    store = new SopVersionStore(cacheDir);
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const makeVersion = (overrides: Partial<SopVersion> = {}): SopVersion => ({
    version: '1.2026.07.28.001',
    knowledge: 'k-1',
    experience: 'e-1',
    malware: 'm-1',
    publishedAt: new Date('2026-07-28T00:00:00Z'),
    hash: 'sha256-abc',
    size: 1024,
    ...overrides,
  });

  // ─── load ──────────────────────────────────────────
  describe('load', () => {
    it('文件不存在时应返回 null（无缓存）', async () => {
      expect(await store.load()).toBeNull();
    });

    it('save 后 load 应返回相同版本数据', async () => {
      const version = makeVersion();
      await store.save(version);
      const loaded = await store.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.version).toBe(version.version);
      expect(loaded?.knowledge).toBe('k-1');
      expect(loaded?.size).toBe(1024);
    });

    it('save 后 version.json 应存在且为格式化 JSON', async () => {
      await store.save(makeVersion({ version: '2.0.0' }));
      const raw = fs.readFileSync(path.join(cacheDir, 'version.json'), 'utf-8');
      expect(raw).toContain('"version": "2.0.0"');
      // 应为格式化输出（包含换行）
      expect(raw).toContain('\n');
    });
  });

  // ─── save 原子写 ──────────────────────────────────
  describe('save 原子写', () => {
    it('写入完成后不应残留 .tmp 临时文件', async () => {
      await store.save(makeVersion());
      expect(fs.existsSync(path.join(cacheDir, 'version.json'))).toBe(true);
      expect(fs.existsSync(path.join(cacheDir, 'version.json.tmp'))).toBe(false);
    });

    it('重复 save 应覆盖旧版本', async () => {
      await store.save(makeVersion({ version: '1.0.0' }));
      await store.save(makeVersion({ version: '2.0.0' }));
      const loaded = await store.load();
      expect(loaded?.version).toBe('2.0.0');
    });
  });

  // ─── logSync ──────────────────────────────────────
  describe('logSync', () => {
    it('应追加一行 JSON 日志到 sync.log', async () => {
      await store.logSync({ event: 'sync', status: 'ok' });
      const raw = fs.readFileSync(path.join(cacheDir, 'sync.log'), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.event).toBe('sync');
      expect(entry.status).toBe('ok');
      expect(entry.timestamp).toBeTruthy();
    });

    it('多次 logSync 应追加而非覆盖', async () => {
      await store.logSync({ idx: 1 });
      await store.logSync({ idx: 2 });
      const raw = fs.readFileSync(path.join(cacheDir, 'sync.log'), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).idx).toBe(1);
      expect(JSON.parse(lines[1]).idx).toBe(2);
    });

    it('日志条目应包含 ISO 时间戳字段', async () => {
      await store.logSync({ foo: 'bar' });
      const raw = fs.readFileSync(path.join(cacheDir, 'sync.log'), 'utf-8');
      const entry = JSON.parse(raw.trim());
      // 应为合法 ISO 字符串
      expect(() => new Date(entry.timestamp).toISOString()).not.toThrow();
    });

    it('日志写入失败不应抛出（不阻塞主流程）', async () => {
      // 指向一个不存在的父目录路径，appendFile 会失败
      const badStore = new SopVersionStore(path.join(cacheDir, 'no-such-dir'));
      await expect(badStore.logSync({ x: 1 })).resolves.toBeUndefined();
    });
  });
});
