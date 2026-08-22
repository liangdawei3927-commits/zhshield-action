import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SopCacheManager } from '../sop/cache/sop-cache-manager';
import { SopCacheMetrics } from '../sop/cache/sop-cache-metrics';
import { MetricsCollector } from '../metrics/metrics-collector';
import { ConflictResolution } from '../sop/sync-conflict';
import type { CounterMetric } from '../index';
import { EventBus } from '../bus';
import { SopRegistry } from '../sop/_meta/sop-registry';
import type { SopDiff } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

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

describe('SopCacheManager 指标接入（MetricsCollector）', () => {
  let cacheDir: string;
  let eventBus: EventBus;
  let registry: SopRegistry;
  let manager: SopCacheManager;

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zh-cache-metrics-${crypto.randomUUID()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    eventBus = new EventBus();
    registry = new SopRegistry();
    manager = new SopCacheManager(registry, { cacheDir, eventBus });
  });

  afterEach(() => {
    eventBus.removeAllListeners();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  function counter(name: string, labels?: Record<string, string>): CounterMetric | undefined {
    return manager
      .getMetricsSnapshot()
      .counters.find((c) =>
        c.name === name &&
        (labels === undefined ||
          Object.entries(labels).every(([k, v]) => c.labels?.[k] === v)),
      );
  }

  it('GIVEN 离线状态 WHEN syncFromCloud THEN 记录同步成功次数与耗时直方图', async () => {
    manager.setOnline(false);
    const result = await manager.syncFromCloud();

    expect(result.updated).toBe(false);
    expect(counter('sop_sync_total', { result: 'success' })?.value).toBe(1);
    const duration = manager
      .getMetricsSnapshot()
      .histograms.find((h) => h.name === 'sop_sync_duration_ms');
    expect(duration).toBeDefined();
    expect(duration?.value).toBeGreaterThanOrEqual(0);
  });

  it('GIVEN 注册中心有规则 WHEN loadRules THEN 命中计数；空模块 THEN 未命中计数', async () => {
    registry.register(makeRule({ id: 'guard.hit', domain: 'guard' }));

    await manager.loadRules('guard');
    await manager.loadRules('refactor');

    expect(counter('sop_cache_lookups_total', { module: 'guard', result: 'hit' })?.value).toBe(1);
    expect(counter('sop_cache_lookups_total', { module: 'refactor', result: 'miss' })?.value).toBe(1);
  });

  it('GIVEN applyDiff 与 emergencyUpdate WHEN 应用规则 THEN 分别按通道记录规则应用量', async () => {
    await manager.applyDiff(makeDiff([makeRule({ id: 'guard.a' }), makeRule({ id: 'guard.b' })]));
    await manager.emergencyUpdate([makeRule({ id: 'security.hot' })]);

    expect(counter('sop_rules_applied_total', { channel: 'diff' })?.value).toBe(2);
    expect(counter('sop_rules_applied_total', { channel: 'emergency' })?.value).toBe(1);
  });

  it('GIVEN clearCache WHEN 清理后 THEN 缓存规模仪表归零', async () => {
    await manager.clearCache();

    const gauge = manager
      .getMetricsSnapshot()
      .gauges.find((g) => g.name === 'sop_cache_rule_count');
    expect(gauge?.value).toBe(0);
  });

  it('GIVEN 外部注入 MetricsCollector WHEN 管理器记录指标 THEN 同一实例可见数据', async () => {
    const external = new MetricsCollector();
    const managed = new SopCacheManager(registry, {
      cacheDir,
      eventBus,
      metricsCollector: external,
      conflictStrategy: ConflictResolution.REMOTE_WINS,
    });

    managed.setOnline(false);
    await managed.syncFromCloud();

    const snapshot = external.snapshot();
    expect(snapshot.counters.find((c) => c.name === 'sop_sync_total')?.value).toBe(1);
    expect(managed.getMetricsSnapshot().counters.length).toBeGreaterThan(0);
  });
});

describe('SopCacheMetrics 失败路径（单元）', () => {
  it('GIVEN recordSyncFailure WHEN 记录 THEN 失败计数与耗时直方图变化', () => {
    const collector = new MetricsCollector();
    const metrics = new SopCacheMetrics(collector);

    metrics.recordSyncFailure(120);

    const failure = collector
      .snapshot()
      .counters.find((c) => c.name === 'sop_sync_total' && c.labels?.result === 'failure');
    expect(failure?.value).toBe(1);
    expect(
      collector.snapshot().histograms.find((h) => h.name === 'sop_sync_duration_ms')?.value,
    ).toBe(120);
  });
});

describe('kernel 入口导出（新增协作者可达）', () => {
  it('GIVEN kernel 入口 WHEN 导入 THEN MetricsCollector/ConflictResolution/DataCleanup 可用', async () => {
    const entry = await import('../index');
    expect(typeof entry.MetricsCollector).toBe('function');
    expect(entry.ConflictResolution.REMOTE_WINS).toBe('remote-wins');
    expect(typeof entry.DataCleanup).toBe('function');
    expect(typeof entry.SmartCompressor).toBe('function');
    expect(typeof entry.SyncConflictResolver).toBe('function');
    expect(typeof entry.SopCacheMaintenance).toBe('function');
  });
});
