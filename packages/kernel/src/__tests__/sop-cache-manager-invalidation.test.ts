import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SopCacheManager } from '../sop/cache/sop-cache-manager';
import { EventBus } from '../bus';
import { SopRegistry } from '../sop/_meta/sop-registry';
import type { SopDiff, SopRule } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

interface CacheSyncedEvent {
  type?: string;
  fromVersion?: string;
  toVersion?: string;
  ruleCount?: number;
  timestamp?: Date;
}

function makeDiff(added: SopRule[]): SopDiff {
  return {
    version: '1.2026.08.20.001',
    fromVersion: '0.0.0',
    compatibility: '>=0.1.0',
    added,
    removed: [],
    modified: [],
    unchanged: [],
    metadata: { totalRules: added.length, diffSize: 0, hash: '' },
  };
}

describe('SopCacheManager 缓存失效事件（三条变更路径）', () => {
  let cacheDir: string;
  let eventBus: EventBus;
  let registry: SopRegistry;
  let manager: SopCacheManager;
  let events: CacheSyncedEvent[];

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zh-cache-invalidate-${crypto.randomUUID()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    eventBus = new EventBus();
    registry = new SopRegistry();
    manager = new SopCacheManager(registry, { cacheDir, eventBus });
    events = [];
    eventBus.on<CacheSyncedEvent>('sop:cache-synced', (payload) => {
      events.push(payload);
    });
  });

  afterEach(() => {
    eventBus.removeAllListeners();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('GIVEN 增量更新 WHEN applyDiff THEN 发射 type=diff 的失效事件（信封与同步路径一致）', async () => {
    const rule = makeRule({ id: 'guard.new-rule' });

    await manager.applyDiff(makeDiff([rule]));
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'diff',
      fromVersion: '0.0.0',
      toVersion: '1.2026.08.20.001',
      ruleCount: 1,
    });
    expect(events[0]?.timestamp).toBeInstanceOf(Date);
  });

  it('GIVEN 紧急推送 WHEN emergencyUpdate THEN 发射 type=emergency 的失效事件', async () => {
    const rules = [makeRule({ id: 'security.hotfix-a' }), makeRule({ id: 'security.hotfix-b' })];

    await manager.emergencyUpdate(rules);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'emergency', ruleCount: 2 });
  });

  it('GIVEN 清理缓存 WHEN clearCache THEN 发射 type=cleared 的失效事件', async () => {
    await manager.clearCache();
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('cleared');
    expect(events[0]?.timestamp).toBeInstanceOf(Date);
  });

  it('GIVEN 三条路径依次执行 WHEN 各自完成 THEN 每条路径各发射一次失效事件', async () => {
    const rule = makeRule({ id: 'guard.all-paths' });

    await manager.applyDiff(makeDiff([rule]));
    await manager.emergencyUpdate([rule]);
    await manager.clearCache();
    await flush();

    expect(events.map((e) => e.type)).toEqual(['diff', 'emergency', 'cleared']);
  });

  it('GIVEN 未配置 eventBus WHEN applyDiff THEN 静默跳过且不抛出', async () => {
    const bare = new SopCacheManager(new SopRegistry(), { cacheDir });

    await expect(
      bare.applyDiff(makeDiff([makeRule({ id: 'guard.quiet' })])),
    ).resolves.toBeUndefined();
  });
});
