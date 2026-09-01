import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SopCacheManager } from '../sop/cache/sop-cache-manager';
import { EventBus } from '../bus';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SyncConflictResolver, ConflictResolution } from '../sop/sync-conflict';
import type { SopDiff, SopRule } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

const MANUAL_RESOLUTION_RE = /manual resolution/;

interface ConflictResolvedEvent {
  ruleId?: string;
  strategy?: string;
  localHash?: string;
  remoteHash?: string;
}

function makeDiff(modified: SopRule[], added: SopRule[] = []): SopDiff {
  return {
    version: '1.2026.08.22.001',
    fromVersion: '0.0.0',
    compatibility: '>=0.1.0',
    added,
    removed: [],
    modified,
    unchanged: [],
    metadata: { totalRules: added.length + modified.length, diffSize: 0, hash: '' },
  };
}

describe('SyncConflictResolver（SHA-256 内容哈希）', () => {
  const resolver = new SyncConflictResolver();

  it('GIVEN 键序不同但内容相同 WHEN detectConflict THEN 返回 null（无冲突）', () => {
    const a = { id: 'r1', content: { pattern: 'x', engine: 'eslint' }, tags: ['a', 'b'] };
    const b = { content: { engine: 'eslint', pattern: 'x' }, tags: ['a', 'b'], id: 'r1' };
    expect(resolver.detectConflict('r1', 1, 2, a, b)).toBeNull();
  });

  it('GIVEN 嵌套内容差异 WHEN detectConflict THEN 检出冲突且哈希不同', () => {
    const a = { id: 'r1', content: { severity: 'low' } };
    const b = { id: 'r1', content: { severity: 'high' } };
    const conflict = resolver.detectConflict('r1', 1, 2, a, b);
    expect(conflict).not.toBeNull();
    expect(conflict?.localHash).not.toBe(conflict?.remoteHash);
    expect(conflict?.detectedAt).toBeInstanceOf(Date);
  });

  it('GIVEN MANUAL 策略 WHEN resolve THEN 抛出需人工处理异常', () => {
    const conflict = resolver.detectConflict('r1', 1, 2, { v: 1 }, { v: 2 })!;
    expect(() => resolver.resolve(conflict, ConflictResolution.MANUAL)).toThrow(
      MANUAL_RESOLUTION_RE,
    );
  });
});

describe('SopCacheManager 冲突解决接入（syncFromCloud/applyDiff 共用链路）', () => {
  let cacheDir: string;
  let eventBus: EventBus;
  let registry: SopRegistry;
  let manager: SopCacheManager;
  let conflictEvents: ConflictResolvedEvent[];

  function createManager(strategy?: ConflictResolution, initialRules: SopRule[] = []): void {
    registry = new SopRegistry();
    for (const rule of initialRules) registry.register(rule);
    manager = new SopCacheManager(registry, {
      cacheDir,
      eventBus,
      ...(strategy ? { conflictStrategy: strategy } : {}),
    });
  }

  beforeEach(() => {
    cacheDir = path.join(os.tmpdir(), `zh-cache-conflict-${crypto.randomUUID()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    eventBus = new EventBus();
    conflictEvents = [];
    eventBus.on<ConflictResolvedEvent>('sop:conflict-resolved', (payload) => {
      conflictEvents.push(payload);
    });
  });

  afterEach(() => {
    eventBus.removeAllListeners();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('GIVEN 本地已有规则且云端内容不同 WHEN applyDiff 默认策略 THEN 云端覆盖本地并记录冲突', async () => {
    const local = makeRule({ id: 'guard.conflict', severity: 'low', description: 'local version' });
    const incoming = makeRule({
      id: 'guard.conflict',
      severity: 'critical',
      description: 'remote version',
    });
    createManager(ConflictResolution.REMOTE_WINS, [local]);

    await manager.applyDiff(makeDiff([incoming]));

    const stored = registry.get('guard.conflict');
    expect(stored?.severity).toBe('critical');
    expect(stored?.description).toBe('remote version');

    const conflicts = manager
      .getMetricsSnapshot()
      .counters.find((c) => c.name === 'sop_conflicts_resolved_total');
    expect(conflicts?.value).toBe(1);
    expect(conflicts?.labels).toMatchObject({ strategy: 'remote-wins' });

    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0]).toMatchObject({ ruleId: 'guard.conflict', strategy: 'remote-wins' });
    expect(conflictEvents[0]?.localHash).toBeTruthy();
    expect(conflictEvents[0]?.remoteHash).toBeTruthy();
  });

  it('GIVEN 本地已有规则且云端内容一致 WHEN applyDiff THEN 无冲突路径照常写入且不记冲突', async () => {
    const local = makeRule({ id: 'guard.same', severity: 'medium', description: 'same' });
    const incoming = makeRule({ id: 'guard.same', severity: 'medium', description: 'same' });
    createManager(undefined, [local]);

    await manager.applyDiff(makeDiff([incoming]));

    expect(registry.get('guard.same')?.severity).toBe('medium');
    const conflicts = manager
      .getMetricsSnapshot()
      .counters.find((c) => c.name === 'sop_conflicts_resolved_total');
    expect(conflicts).toBeUndefined();
    expect(conflictEvents).toHaveLength(0);
  });

  it('GIVEN MERGE 策略 WHEN 重叠字段冲突 THEN 保留本地字段值', async () => {
    const local = makeRule({ id: 'guard.merge', description: 'local desc', severity: 'high' });
    const incoming = makeRule({ id: 'guard.merge', description: 'remote desc', severity: 'low' });
    createManager(ConflictResolution.MERGE, [local]);

    await manager.applyDiff(makeDiff([incoming]));

    expect(registry.get('guard.merge')?.description).toBe('local desc');
    const conflicts = manager
      .getMetricsSnapshot()
      .counters.find((c) => c.name === 'sop_conflicts_resolved_total');
    expect(conflicts?.labels).toMatchObject({ strategy: 'merge' });
  });

  it('GIVEN LOCAL_WINS 策略 WHEN 内容冲突 THEN 本地内容保留', async () => {
    const local = makeRule({ id: 'guard.local', severity: 'low' });
    const incoming = makeRule({ id: 'guard.local', severity: 'critical' });
    createManager(ConflictResolution.LOCAL_WINS, [local]);

    await manager.applyDiff(makeDiff([incoming]));

    expect(registry.get('guard.local')?.severity).toBe('low');
  });

  it('GIVEN MANUAL 策略 WHEN 内容冲突 THEN applyDiff 拒绝执行', async () => {
    const local = makeRule({ id: 'guard.manual', severity: 'low' });
    const incoming = makeRule({ id: 'guard.manual', severity: 'critical' });
    createManager(ConflictResolution.MANUAL, [local]);

    await expect(manager.applyDiff(makeDiff([incoming]))).rejects.toThrow(MANUAL_RESOLUTION_RE);
  });

  it('GIVEN 紧急推送与本地规则冲突 WHEN emergencyUpdate THEN 同样走冲突解决策略', async () => {
    const local = makeRule({ id: 'security.hotfix', severity: 'medium' });
    const incoming = makeRule({ id: 'security.hotfix', severity: 'critical' });
    createManager(ConflictResolution.REMOTE_WINS, [local]);

    await manager.emergencyUpdate([incoming]);

    expect(registry.get('security.hotfix')?.severity).toBe('critical');
    const conflicts = manager
      .getMetricsSnapshot()
      .counters.find((c) => c.name === 'sop_conflicts_resolved_total');
    expect(conflicts?.value).toBe(1);
  });

  it('GIVEN 新增规则本地不存在 WHEN applyDiff THEN 不触发冲突检测直接注册', async () => {
    createManager(ConflictResolution.MANUAL, []);

    await manager.applyDiff(makeDiff([], [makeRule({ id: 'guard.fresh' })]));

    expect(registry.get('guard.fresh')).toBeDefined();
    expect(
      manager.getMetricsSnapshot().counters.find((c) => c.name === 'sop_conflicts_resolved_total'),
    ).toBeUndefined();
  });
});
