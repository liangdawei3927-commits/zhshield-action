import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { DataCleanup } from '../sop/data-cleanup';
import { SopCacheManager } from '../sop/cache/sop-cache-manager';
import { EventBus } from '../bus';
import { SopRegistry } from '../sop/_meta/sop-registry';
import type { SopDiff, SopRule } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

interface MaintenanceEvent {
  trigger?: string;
  rulesBefore?: number;
  rulesAfter?: number;
  rulesRemoved?: number;
  logEntriesBefore?: number;
  logEntriesAfter?: number;
  logEntriesRemoved?: number;
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

function seedRules(count: number): SopRule[] {
  const base = Date.now() - count * 1000;
  return Array.from({ length: count }, (_, i) =>
    makeRule({ id: `guard.seed-${i + 1}`, updatedAt: new Date(base + i * 1000) }),
  );
}

describe('DataCleanup（清理 API 单元）', () => {
  const cleanup = new DataCleanup({ maxAgeDays: 90 });

  it('GIVEN 超龄条目 WHEN cleanup THEN 仅保留新鲜条目且 kept 可用', () => {
    const now = Date.now();
    const entries = [
      { timestamp: new Date(now - 200 * 24 * 60 * 60 * 1000).toISOString(), v: 'old' },
      { timestamp: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(), v: 'fresh' },
    ];

    const result = cleanup.cleanup(entries);

    expect(result.totalBefore).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.kept.map((e) => e.v)).toEqual(['fresh']);
  });

  it('GIVEN 条目数超上限 WHEN cleanup THEN 只保留最新 maxEntries 条', () => {
    const entries = [1, 2, 3, 4, 5].map((i) => ({
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      v: i,
    }));

    const result = cleanup.cleanup(entries, { maxEntries: 3 });

    expect(result.removed).toBe(2);
    expect(result.kept.map((e) => e.v)).toEqual([3, 4, 5]);
  });

  it('GIVEN 全部超龄但总量不低于 keepMinimum WHEN cleanup THEN 保留下限兜底生效', () => {
    const cleanupFloor = new DataCleanup({ maxAgeDays: 7, keepMinimum: 3 });
    const entries = [10, 9, 8].map((i) => ({
      timestamp: new Date(Date.now() - i * 30 * 24 * 60 * 60 * 1000).toISOString(),
      v: i,
    }));

    const result = cleanupFloor.cleanup(entries);

    expect(result.removed).toBe(0);
    expect(result.kept).toHaveLength(3);
  });

  it('GIVEN 版本序列 WHEN trimVersions THEN 保留最近 N 个版本', () => {
    const versions = [1, 2, 3, 4, 5].map((version) => ({ version, tag: `v${version}` }));

    expect(cleanup.trimVersions(versions, 2)).toEqual([
      { version: 4, tag: 'v4' },
      { version: 5, tag: 'v5' },
    ]);
  });
});

describe('SopCacheManager 自动维护接入（DataCleanup）', () => {
  let cacheDir: string;
  let eventBus: EventBus;
  let registry: SopRegistry;
  let manager: SopCacheManager;
  let events: MaintenanceEvent[];

  function createManager(cleanupConfig?: { maxEntries: number; keepMinimum: number }): void {
    manager = new SopCacheManager(registry, { cacheDir, eventBus, cleanup: cleanupConfig });
  }

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zh-cache-cleanup-${crypto.randomUUID()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    eventBus = new EventBus();
    events = [];
    eventBus.on<MaintenanceEvent>('sop:maintenance-completed', (payload) => {
      events.push(payload);
    });
  });

  afterEach(() => {
    eventBus.removeAllListeners();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('GIVEN 规则数超上限 WHEN initialize THEN init 触发裁剪并保留最新条目', async () => {
    registry = new SopRegistry();
    for (const rule of seedRules(5)) registry.register(rule);
    createManager({ maxEntries: 3, keepMinimum: 2 });

    await manager.initialize();

    expect(registry.count()).toBe(3);
    expect(registry.getAll().map((r) => r.id)).toEqual(['guard.seed-3', 'guard.seed-4', 'guard.seed-5']);

    const initEvent = events.find((e) => e.trigger === 'init');
    expect(initEvent).toMatchObject({ rulesBefore: 5, rulesAfter: 3, rulesRemoved: 2 });
  });

  it('GIVEN 裁剪后新增规则再次越限 WHEN applyDiff THEN diff 触发二次裁剪', async () => {
    registry = new SopRegistry();
    for (const rule of seedRules(5)) registry.register(rule);
    createManager({ maxEntries: 3, keepMinimum: 2 });
    await manager.initialize();

    await manager.applyDiff(makeDiff([makeRule({ id: 'guard.newcomer' })]));

    expect(registry.count()).toBe(3);
    expect(registry.get('guard.newcomer')).toBeDefined();
    const diffEvent = events.find((e) => e.trigger === 'diff');
    expect(diffEvent).toMatchObject({ rulesBefore: 4, rulesAfter: 3, rulesRemoved: 1 });
  });

  it('GIVEN 紧急推送 WHEN emergencyUpdate THEN 发射 emergency 维护事件', async () => {
    registry = new SopRegistry();
    createManager();

    await manager.emergencyUpdate([makeRule({ id: 'security.hotfix' })]);

    const emergencyEvent = events.find((e) => e.trigger === 'emergency');
    expect(emergencyEvent).toMatchObject({ rulesBefore: 1, rulesAfter: 1, rulesRemoved: 0 });
  });

  it('GIVEN 裁剪后剩余低于 keepMinimum WHEN 触发维护 THEN 放弃裁剪保护下限', async () => {
    registry = new SopRegistry();
    for (const rule of seedRules(5)) registry.register(rule);
    createManager({ maxEntries: 2, keepMinimum: 10 });

    await manager.initialize();

    expect(registry.count()).toBe(5);
    const initEvent = events.find((e) => e.trigger === 'init');
    expect(initEvent?.rulesRemoved).toBe(0);
  });

  it('GIVEN sync.log 含超期日志 WHEN initialize THEN 按时间淘汰并重写文件', async () => {
    registry = new SopRegistry();
    createManager();
    const day = 24 * 60 * 60 * 1000;
    const lines = [
      JSON.stringify({ timestamp: new Date(Date.now() - 100 * day).toISOString(), from: '0', to: 'x' }),
      JSON.stringify({ timestamp: new Date(Date.now() - 95 * day).toISOString(), from: 'x', to: 'y' }),
      JSON.stringify({ timestamp: new Date().toISOString(), from: 'y', to: 'z' }),
    ];
    fs.writeFileSync(path.join(cacheDir, 'sync.log'), lines.join('\n') + '\n', 'utf-8');

    await manager.initialize();

    const logEvent = events.find((e) => e.trigger === 'init');
    expect(logEvent?.logEntriesBefore).toBe(3);
    expect(logEvent?.logEntriesRemoved).toBe(2);
    expect(logEvent?.logEntriesAfter).toBe(1);

    const remaining = fs.readFileSync(path.join(cacheDir, 'sync.log'), 'utf-8').trim().split('\n');
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0])).toMatchObject({ from: 'y', to: 'z' });
  });

  it('GIVEN 发生裁剪 WHEN 维护完成 THEN 清理计数与缓存规模指标更新', async () => {
    registry = new SopRegistry();
    for (const rule of seedRules(5)) registry.register(rule);
    createManager({ maxEntries: 3, keepMinimum: 2 });

    await manager.initialize();

    const snapshot = manager.getMetricsSnapshot();
    expect(snapshot.counters.find((c) => c.name === 'sop_cleanup_removed_total')?.value).toBe(2);
    expect(snapshot.gauges.find((g) => g.name === 'sop_cache_rule_count')?.value).toBe(3);
  });
});
