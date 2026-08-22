import { describe, it, expect, vi } from 'vitest';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

/** 构造一个 mock EventBus，捕获 emit 调用 */
function makeEventBusMock() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    emitted,
    bus: {
      emit: vi.fn(async (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      }),
    },
  };
}

describe('SopRegistry', () => {
  // ─── register / get / getAll ─────────────────────
  describe('register / get / getAll', () => {
    it('register 后 get 应返回该规则（防御性拷贝）', () => {
      const reg = new SopRegistry();
      const rule = makeRule({ id: 'r-1', name: 'original' });
      reg.register(rule);
      const got = reg.get('r-1');
      expect(got).toBeDefined();
      expect(got?.id).toBe('r-1');
      // 修改原始对象不应影响注册表内的副本
      rule.name = 'mutated';
      expect(reg.get('r-1')?.name).toBe('original');
    });

    it('重复注册同一 id 应抛错', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1' }));
      expect(() => reg.register(makeRule({ id: 'r-1' }))).toThrow(
        'SOP rule already registered: r-1',
      );
    });

    it('get 不存在的 id 应返回 undefined', () => {
      expect(new SopRegistry().get('nope')).toBeUndefined();
    });

    it('has 对已注册 id 返回 true，未注册返回 false', () => {
      const reg = new SopRegistry();
      expect(reg.has('r-1')).toBe(false);
      reg.register(makeRule({ id: 'r-1' }));
      expect(reg.has('r-1')).toBe(true);
    });

    it('getAll 应返回当前所有规则的数组', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1' }));
      reg.register(makeRule({ id: 'r-2' }));
      expect(reg.getAll().length).toBe(2);
    });

    it('register 应触发 added 事件', async () => {
      const { bus, emitted } = makeEventBusMock();
      const reg = new SopRegistry(bus as never);
      reg.register(makeRule({ id: 'r-1' }));
      expect(bus.emit).toHaveBeenCalledTimes(1);
      expect(emitted[0].event).toBe('sop:rule-changed');
      expect((emitted[0].payload as { type: string }).type).toBe('added');
    });
  });

  // ─── update ──────────────────────────────────────
  describe('update', () => {
    it('更新不存在的规则应抛错', () => {
      const reg = new SopRegistry();
      expect(() => reg.update('nope', { name: 'x' })).toThrow('SOP rule not found: nope');
    });

    it('应合并字段并更新 updatedAt', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', name: 'old' }));
      const before = reg.get('r-1')!.updatedAt;
      const updated = reg.update('r-1', { name: 'new' });
      expect(updated.name).toBe('new');
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('状态变化应触发 status-changed 事件并携带 previousStatus', () => {
      const { bus, emitted } = makeEventBusMock();
      const reg = new SopRegistry(bus as never);
      reg.register(makeRule({ id: 'r-1', status: 'active' }));
      reg.update('r-1', { status: 'trial' });
      const change = emitted[1].payload as { type: string; previousStatus?: string };
      expect(change.type).toBe('status-changed');
      expect(change.previousStatus).toBe('active');
    });

    it('非状态更新应触发 modified 事件', () => {
      const { bus, emitted } = makeEventBusMock();
      const reg = new SopRegistry(bus as never);
      reg.register(makeRule({ id: 'r-1', name: 'old' }));
      reg.update('r-1', { name: 'new' });
      const change = emitted[1].payload as { type: string };
      expect(change.type).toBe('modified');
    });

    it('状态相同（未变化）应触发 modified 而非 status-changed', () => {
      const { bus, emitted } = makeEventBusMock();
      const reg = new SopRegistry(bus as never);
      reg.register(makeRule({ id: 'r-1', status: 'active' }));
      reg.update('r-1', { status: 'active', name: 'x' });
      // 第二个事件应为 modified
      expect((emitted[1].payload as { type: string }).type).toBe('modified');
    });
  });

  // ─── remove ──────────────────────────────────────
  describe('remove', () => {
    it('删除存在的规则应返回 true 并触发 removed 事件', () => {
      const { bus, emitted } = makeEventBusMock();
      const reg = new SopRegistry(bus as never);
      reg.register(makeRule({ id: 'r-1' }));
      expect(reg.remove('r-1')).toBe(true);
      expect(reg.get('r-1')).toBeUndefined();
      expect((emitted[1].payload as { type: string }).type).toBe('removed');
    });

    it('删除不存在的规则应返回 false 且不触发事件', () => {
      const { bus } = makeEventBusMock();
      const reg = new SopRegistry();
      expect(reg.remove('nope')).toBe(false);
      expect(bus.emit).not.toHaveBeenCalled();
    });
  });

  // ─── query ───────────────────────────────────────
  describe('query', () => {
    function setupRules() {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', domain: 'guard', action: 'scan', source: 'official', status: 'active', severity: 'high', tags: ['ts'] }));
      reg.register(makeRule({ id: 'r-2', domain: 'inspect', action: 'block', source: 'community', status: 'trial', severity: 'low', tags: ['vue'] }));
      reg.register(makeRule({ id: 'r-3', domain: 'guard', action: 'scan', source: 'official', status: 'deprecated', severity: 'high', tags: ['ts', 'security'] }));
      return reg;
    }

    it('空过滤器应返回全部', () => {
      expect(setupRules().query({}).length).toBe(3);
    });

    it('按 domain 过滤', () => {
      expect(setupRules().query({ domain: 'guard' }).length).toBe(2);
    });

    it('按 action 过滤', () => {
      expect(setupRules().query({ action: 'block' }).length).toBe(1);
    });

    it('按 source 过滤', () => {
      expect(setupRules().query({ source: 'community' }).length).toBe(1);
    });

    it('按 status 过滤', () => {
      expect(setupRules().query({ status: 'active' }).length).toBe(1);
    });

    it('按 severity 过滤', () => {
      expect(setupRules().query({ severity: 'high' }).length).toBe(2);
    });

    it('按 tags 过滤（任一匹配）', () => {
      expect(setupRules().query({ tags: ['ts'] }).length).toBe(2);
      expect(setupRules().query({ tags: ['security'] }).length).toBe(1);
    });

    it('空 tags 数组不应过滤', () => {
      expect(setupRules().query({ tags: [] }).length).toBe(3);
    });

    it('search 应匹配 id/name/description（大小写不敏感）', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', name: 'TypeScript Strict', description: '' }));
      reg.register(makeRule({ id: 'r-2', name: 'other', description: 'vue guide' }));
      expect(reg.query({ search: 'typescript' }).length).toBe(1);
      expect(reg.query({ search: 'GUIDE' }).length).toBe(1);
    });

    it('多条件组合（AND 语义）', () => {
      const reg = setupRules();
      const results = reg.query({ domain: 'guard', status: 'active' });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('r-1');
    });
  });

  // ─── getByDomain / getByAction / getActive ───────
  describe('getByDomain / getByAction / getActive', () => {
    it('getByDomain 应返回对应域的规则', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', domain: 'guard' }));
      reg.register(makeRule({ id: 'r-2', domain: 'inspect' }));
      expect(reg.getByDomain('guard').length).toBe(1);
    });

    it('getByAction 应返回对应动作的规则', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', action: 'scan' }));
      reg.register(makeRule({ id: 'r-2', action: 'block' }));
      expect(reg.getByAction('block').length).toBe(1);
    });

    it('getActive 应只返回 status=active', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', status: 'active' }));
      reg.register(makeRule({ id: 'r-2', status: 'trial' }));
      expect(reg.getActive().length).toBe(1);
    });
  });

  // ─── getStats ────────────────────────────────────
  describe('getStats', () => {
    it('空注册表应返回 totalRules=0', () => {
      const stats = new SopRegistry().getStats();
      expect(stats.totalRules).toBe(0);
    });

    it('应正确按维度统计', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', domain: 'guard', action: 'scan', status: 'active', severity: 'high' }));
      reg.register(makeRule({ id: 'r-2', domain: 'guard', action: 'block', status: 'trial', severity: 'high' }));
      const stats = reg.getStats();
      expect(stats.totalRules).toBe(2);
      expect(stats.byDomain.guard).toBe(2);
      expect(stats.byAction.scan).toBe(1);
      expect(stats.byAction.block).toBe(1);
      expect(stats.byStatus.active).toBe(1);
      expect(stats.byStatus.trial).toBe(1);
      expect(stats.bySeverity.high).toBe(2);
    });
  });

  // ─── evaluateLifecycle ──────────────────────────
  describe('evaluateLifecycle', () => {
    it('active + 误报率>10% 应降级为 trial', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', status: 'active', falsePositiveCount: 20, truePositiveCount: 10 }));
      const result = reg.evaluateLifecycle();
      expect(result.downgraded).toContain('r-1');
      expect(reg.get('r-1')?.status).toBe('trial');
    });

    it('active + 误报率<=10% 应保持 active', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', status: 'active', falsePositiveCount: 5, truePositiveCount: 100 }));
      const result = reg.evaluateLifecycle();
      expect(result.downgraded).not.toContain('r-1');
      expect(reg.get('r-1')?.status).toBe('active');
    });

    it('active + 无反馈数据应保持 active（不评估降级）', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', status: 'active', falsePositiveCount: 0, truePositiveCount: 0 }));
      const result = reg.evaluateLifecycle();
      expect(result.downgraded).not.toContain('r-1');
    });

    it('active + 90天未使用应废弃为 deprecated', () => {
      const reg = new SopRegistry();
      const longAgo = new Date(Date.now() - 91 * 86_400_000);
      reg.register(makeRule({ id: 'r-1', status: 'active', falsePositiveCount: 0, truePositiveCount: 0, lastUsedAt: longAgo }));
      const result = reg.evaluateLifecycle();
      expect(result.deprecated).toContain('r-1');
      expect(reg.get('r-1')?.status).toBe('deprecated');
    });

    it('trial + 误报率<1% + 创建>30天应升级为 active', () => {
      const reg = new SopRegistry();
      const oldCreated = new Date(Date.now() - 31 * 86_400_000);
      const rule = makeRule({ id: 'r-1', status: 'trial', falsePositiveCount: 1, truePositiveCount: 200 });
      rule.createdAt = oldCreated;
      reg.register(rule);
      const result = reg.evaluateLifecycle();
      expect(result.upgraded).toContain('r-1');
      expect(reg.get('r-1')?.status).toBe('active');
    });

    it('trial + 创建不足30天应保持 trial', () => {
      const reg = new SopRegistry();
      const rule = makeRule({ id: 'r-1', status: 'trial', falsePositiveCount: 0, truePositiveCount: 200 });
      rule.createdAt = new Date(); // 刚创建
      reg.register(rule);
      const result = reg.evaluateLifecycle();
      expect(result.upgraded).not.toContain('r-1');
    });

    it('deprecated 状态不应被自动变更', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1', status: 'deprecated', falsePositiveCount: 50, truePositiveCount: 0 }));
      const result = reg.evaluateLifecycle();
      expect(result.downgraded).not.toContain('r-1');
      expect(result.upgraded).not.toContain('r-1');
      expect(result.deprecated).not.toContain('r-1');
    });
  });

  // ─── loadAll / clear / count ─────────────────────
  describe('loadAll / clear / count', () => {
    it('loadAll 应清空后批量加载', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'old' }));
      reg.loadAll([makeRule({ id: 'r-1' }), makeRule({ id: 'r-2' })]);
      expect(reg.count()).toBe(2);
      expect(reg.get('old')).toBeUndefined();
    });

    it('loadAll 应对规则做防御性拷贝', () => {
      const reg = new SopRegistry();
      const rule = makeRule({ id: 'r-1', name: 'original' });
      reg.loadAll([rule]);
      rule.name = 'mutated';
      expect(reg.get('r-1')?.name).toBe('original');
    });

    it('clear 应清空所有规则', () => {
      const reg = new SopRegistry();
      reg.register(makeRule({ id: 'r-1' }));
      reg.clear();
      expect(reg.count()).toBe(0);
      expect(reg.getAll()).toEqual([]);
    });

    it('count 应返回当前规则数', () => {
      const reg = new SopRegistry();
      expect(reg.count()).toBe(0);
      reg.register(makeRule({ id: 'r-1' }));
      expect(reg.count()).toBe(1);
    });
  });

  // ─── 事件总线失败容错 ─────────────────────────────
  describe('事件总线容错', () => {
    it('eventBus.emit 抛错不应阻断 register 主流程', () => {
      const failingBus = {
        emit: vi.fn().mockRejectedValue(new Error('bus down')),
      };
      const reg = new SopRegistry(failingBus as never);
      expect(() => reg.register(makeRule({ id: 'r-1' }))).not.toThrow();
      expect(reg.get('r-1')).toBeDefined();
    });
  });
});
