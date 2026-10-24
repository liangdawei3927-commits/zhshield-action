import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SopVersionStore, emptySyncState } from '../sop/cache/sop-version-store';
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

// ─── 同步状态持久化（2026-10-24：健康度的事实源） ─────────────
// 背景：健康度原先只看内存 lastSyncTime，进程重启即归零，
// 「本次运行还没同步成功」被误判成「规则严重过期」。
describe('SopVersionStore 同步状态持久化', () => {
  let cacheDir: string;
  let store: SopVersionStore;

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zhshield-syncstate-${crypto.randomUUID()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    store = new SopVersionStore(cacheDir);
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const writeVersionFile = (publishedAt: string, version = '1.2026.09.24.209'): void => {
    fs.writeFileSync(
      path.join(cacheDir, 'version.json'),
      JSON.stringify({
        version,
        knowledge: '1.2026.09.24',
        experience: '1.2026.09.24',
        malware: '1.2026.09.24',
        hash: 'a'.repeat(64),
        publishedAt,
      }),
    );
  };

  it('无任何文件时应返回空状态（确实从未同步过）', async () => {
    expect(await store.loadSyncState()).toEqual(emptySyncState());
  });

  it('只有 version.json（老用户升级）时应从 publishedAt 回溯出 everSucceeded=true', async () => {
    // 升级兼容的关键：老缓存目录里没有 sync-state.json，
    // 若直接判「从未同步」，会把一份正常的旧缓存误报成「尚未接入云端」——
    // 那只是把一种谎话换成另一种谎话。
    writeVersionFile('2026-09-24T20:14:07.879Z');

    const state = await store.loadSyncState();
    expect(state.everSucceeded).toBe(true);
    expect(state.lastSuccessAt).toBe('2026-09-24T20:14:07.879Z');
    expect(state.lastError).toBeNull();
  });

  // ─── 回溯源优先级：sync.log > version.json ─────────────────
  // 这个顺序不是洁癖：publishedAt 是「云端包发布时刻」，sync.log 是「本地同步成功时刻」。
  // 二者可以差一整天。同步一个昨天发布的包，按 publishedAt 算会把「刚刚成功」判成「1 天前」。
  describe('GIVEN 无 sync-state.json 但有 sync.log', () => {
    const writeLog = (lines: Array<Record<string, unknown>>): void => {
      fs.writeFileSync(
        path.join(cacheDir, 'sync.log'),
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
    };

    it('WHEN sync.log 时间晚于 publishedAt THEN 取 sync.log 的真实同步时刻', async () => {
      writeVersionFile('2026-09-24T20:14:07.879Z');
      writeLog([
        { timestamp: '2026-09-07T18:57:10.163Z', from: '0.0.0', to: '1.2026.07.28.001' },
        { timestamp: '2026-09-25T18:03:13.388Z', from: '1.2026.07.28.001', to: '1.2026.09.24.209' },
      ]);

      const state = await store.loadSyncState();
      expect(state.everSucceeded).toBe(true);
      expect(state.lastSuccessAt).toBe('2026-09-25T18:03:13.388Z');
      // 反证：若回退到 publishedAt，这里会是 09-24，多算一天
      expect(state.lastSuccessAt).not.toBe('2026-09-24T20:14:07.879Z');
    });

    it('WHEN 同步的包发布于昨天 THEN 不得被判成「1 天前」（刚同步成功仍属今天）', async () => {
      // 真实形态：云端昨天发版，客户端今天才同步成功
      const yesterday = new Date(Date.now() - 86_400_000).toISOString();
      const now = new Date().toISOString();
      writeVersionFile(yesterday);
      writeLog([{ timestamp: now, from: '1.0.0', to: '1.0.1' }]);

      const state = await store.loadSyncState();
      expect(state.lastSuccessAt).toBe(now);
      const days = (Date.now() - Date.parse(state.lastSuccessAt!)) / 86_400_000;
      expect(days).toBeLessThan(1);
    });

    it('WHEN sync.log 全是坏行 THEN 回退到 version.json 而非判从未同步', async () => {
      writeVersionFile('2026-09-24T20:14:07.879Z');
      fs.writeFileSync(path.join(cacheDir, 'sync.log'), 'not-json\n{broken\n');

      const state = await store.loadSyncState();
      expect(state.everSucceeded).toBe(true);
      expect(state.lastSuccessAt).toBe('2026-09-24T20:14:07.879Z');
    });

    it('WHEN 有 sync-state.json THEN 状态文件优先（它带失败原因，日志没有）', async () => {
      writeVersionFile('2026-09-24T20:14:07.879Z');
      writeLog([{ timestamp: '2026-09-25T18:03:13.388Z', from: 'a', to: 'b' }]);
      await store.saveSyncState({
        lastSuccessAt: '2026-09-25T18:03:13.388Z',
        lastAttemptAt: '2026-10-23T21:05:42.652Z',
        lastError: 'network_error',
        everSucceeded: true,
      });

      const state = await store.loadSyncState();
      expect(state.lastError).toBe('network_error');
      expect(state.lastAttemptAt).toBe('2026-10-23T21:05:42.652Z');
    });
  });

  it('save 后 load 应完全一致', async () => {
    const saved = {
      lastSuccessAt: '2026-10-01T00:00:00.000Z',
      lastAttemptAt: '2026-10-02T00:00:00.000Z',
      lastError: 'network_error',
      everSucceeded: true,
    };
    await store.saveSyncState(saved);

    expect(await store.loadSyncState()).toEqual(saved);
  });

  it('状态文件损坏时应回退到 version.json 推断，而不是抛错', async () => {
    writeVersionFile('2026-09-24T20:14:07.879Z');
    fs.writeFileSync(path.join(cacheDir, 'sync-state.json'), '{ this is not json');

    const state = await store.loadSyncState();
    expect(state.everSucceeded).toBe(true);
    expect(state.lastSuccessAt).toBe('2026-09-24T20:14:07.879Z');
  });

  it('everSucceeded=true 但 lastSuccessAt 为 null 时应保留「接入过」的判断', async () => {
    // 时间字段损坏但标志位在：宁可判「已过期」（时间未知按最严重算），
    // 也不能说用户从未接入过云端 —— 后者会给出完全错误的处置建议
    fs.writeFileSync(
      path.join(cacheDir, 'sync-state.json'),
      JSON.stringify({
        lastSuccessAt: null,
        lastAttemptAt: '2026-10-02T00:00:00.000Z',
        lastError: 'network_error',
        everSucceeded: true,
      }),
    );

    const state = await store.loadSyncState();
    expect(state.everSucceeded).toBe(true);
    expect(state.lastSuccessAt).toBeNull();
    expect(state.lastError).toBe('network_error');
  });

  it('字段类型非法时应归 null，不污染健康度', async () => {
    fs.writeFileSync(
      path.join(cacheDir, 'sync-state.json'),
      JSON.stringify({
        lastSuccessAt: 'not-a-date',
        lastAttemptAt: 12345,
        lastError: 42,
        everSucceeded: 'yes',
      }),
    );

    const state = await store.loadSyncState();
    expect(state.lastSuccessAt).toBeNull();
    expect(state.lastAttemptAt).toBeNull();
    expect(state.lastError).toBeNull();
    expect(state.everSucceeded).toBe(false);
  });
});
