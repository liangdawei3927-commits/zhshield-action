import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSentinelEvent } from '@zh/db';
import { EventCenter } from '../event-center';

describe('EventCenter', () => {
  let ec: EventCenter;

  beforeEach(() => {
    ec = new EventCenter();
  });

  function filterByTitle(center: EventCenter, title: string) {
    return center.listEvents().filter((e) => e.title === title);
  }

  describe('createEvent', () => {
    it('should create an event with generated id', () => {
      const event = ec.createEvent({
        projectId: 'proj-1',
        title: 'Test Event',
        service: 'api',
        module: 'auth',
        severity: 'p1',
      });
      expect(event.id).toBeDefined();
      expect(event.projectId).toBe('proj-1');
      expect(event.title).toBe('Test Event');
      expect(event.severity).toBe('p1');
      expect(event.status).toBe('detected');
      expect(event.occurrenceCount).toBe(1);
    });

    it('should set defaults for optional fields', () => {
      const event = ec.createEvent({ projectId: 'proj-1', title: 'Minimal' });
      expect(event.service).toBe('');
      expect(event.module).toBe('');
      expect(event.severity).toBe('p3');
    });

    it('should include history entry', () => {
      const event = ec.createEvent({
        projectId: 'proj-1',
        title: 'With History',
        operator: 'admin',
        detail: 'Manually created',
      });
      expect(event.history).toHaveLength(1);
      expect(event.history[0].action).toBe('event-created');
      expect(event.history[0].operator).toBe('admin');
    });

    it('should deduplicate repeated events with explicit dedupeKey', () => {
      const params = { projectId: 'proj-1', title: 'Repeated', dedupeKey: 'stable-key-1' };
      const first = ec.createEvent(params);
      const second = ec.createEvent(params);
      expect(second.id).toBe(first.id);
      expect(second.occurrenceCount).toBe(2);
      expect(second.history[1].action).toBe('event-repeat');
      expect(filterByTitle(ec, 'Repeated')).toHaveLength(1);
    });

    it('should keep unique events without dedupeKey', () => {
      const params = { projectId: 'proj-1', title: 'Default Unique' };
      const first = ec.createEvent(params);
      const second = ec.createEvent(params);
      expect(second.id).not.toBe(first.id);
      expect(filterByTitle(ec, 'Default Unique')).toHaveLength(2);
    });
  });

  describe('getEvent', () => {
    it('should retrieve an event by id', () => {
      const created = ec.createEvent({ projectId: 'proj-1', title: 'Find Me' });
      const found = ec.getEvent(created.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe('Find Me');
    });

    it('should return undefined for unknown id', () => {
      expect(ec.getEvent('nonexistent')).toBeUndefined();
    });
  });

  describe('listEvents', () => {
    it('should list all events', () => {
      ec.createEvent({ projectId: 'proj-1', title: 'Event A' });
      ec.createEvent({ projectId: 'proj-1', title: 'Event B' });
      expect(ec.listEvents()).toHaveLength(2);
    });

    it('should filter by status', () => {
      const e1 = ec.createEvent({ projectId: 'proj-1', title: 'A' });
      ec.createEvent({ projectId: 'proj-1', title: 'B' });
      ec.updateStatus(e1.id, 'resolved', 'admin');
      expect(ec.listEvents({ status: 'resolved' })).toHaveLength(1);
      expect(ec.listEvents({ status: 'detected' })).toHaveLength(1);
    });

    it('should filter by severity', () => {
      ec.createEvent({ projectId: 'proj-1', title: 'P1', severity: 'p1' });
      ec.createEvent({ projectId: 'proj-1', title: 'P2', severity: 'p2' });
      ec.createEvent({ projectId: 'proj-1', title: 'P3', severity: 'p3' });
      expect(ec.listEvents({ severity: 'p1' })).toHaveLength(1);
      expect(ec.listEvents({ severity: 'p2' })).toHaveLength(1);
      expect(ec.listEvents({ severity: 'p3' })).toHaveLength(1);
    });

    it('should sort by timestamp descending', async () => {
      ec.createEvent({ projectId: 'proj-1', title: 'First' });
      await new Promise((r) => setTimeout(r, 15));
      ec.createEvent({ projectId: 'proj-1', title: 'Second' });
      const events = ec.listEvents();
      expect(events[0].title).toBe('Second');
      expect(events[1].title).toBe('First');
    });
  });

  describe('updateStatus', () => {
    it('should update status and add history', () => {
      const event = ec.createEvent({ projectId: 'proj-1', title: 'To Update' });
      const updated = ec.updateStatus(event.id, 'fixing', 'developer');
      expect(updated).toBeDefined();
      expect(updated!.status).toBe('fixing');
      expect(updated!.history).toHaveLength(2);
      expect(updated!.history[1].action).toContain('detected->fixing');
    });

    it('should return null for unknown event', () => {
      expect(ec.updateStatus('nonexistent', 'resolved')).toBeNull();
    });
  });

  describe('updateValidation', () => {
    it('should update validation status', () => {
      const event = ec.createEvent({ projectId: 'proj-1', title: 'Validate' });
      const updated = ec.updateValidation(event.id, 'pass', 'ci-runner');
      expect(updated).toBeDefined();
      expect(updated!.validation.status).toBe('pass');
      expect(updated!.validation.source).toBe('ci-runner');
    });

    it('should return null for unknown event', () => {
      expect(ec.updateValidation('nonexistent', 'pass')).toBeNull();
    });
  });

  describe('processAlert', () => {
    it('should create a new event from alert payload', () => {
      const payload = {
        alerts: [
          {
            fingerprint: 'fp-1',
            labels: {
              alertname: 'ServerError',
              service: 'api',
              module: 'auth',
              severity: 'critical',
              repo: 'proj-1',
            },
            annotations: { summary: 'Server 500 errors detected' },
          },
        ],
      };
      const { event, isNew } = ec.processAlert(payload);
      expect(isNew).toBe(true);
      expect(event.title).toBe('Server 500 errors detected');
      expect(event.severity).toBe('p1');
      expect(event.service).toBe('api');
      expect(event.module).toBe('auth');
      expect(event.projectId).toBe('proj-1');
    });

    it('should deduplicate repeated alerts', () => {
      const payload = {
        alerts: [
          {
            fingerprint: 'fp-dedup',
            labels: {
              alertname: 'DedupTest',
              service: 'api',
              module: 'core',
              severity: 'high',
              repo: 'proj-1',
            },
            annotations: { summary: 'Dedup test' },
          },
        ],
      };
      const first = ec.processAlert(payload);
      const second = ec.processAlert(payload);
      expect(first.isNew).toBe(true);
      expect(second.isNew).toBe(false);
      expect(first.event.id).toBe(second.event.id);
      expect(second.event.occurrenceCount).toBe(2);
    });

    it('should map severity correctly', () => {
      const make = (sev: string) => ({
        alerts: [
          {
            fingerprint: `fp-${sev}`,
            labels: { alertname: 'test', service: 'api', module: 'core', severity: sev, repo: 'p' },
            annotations: { summary: 'test' },
          },
        ],
      });
      expect(ec.processAlert(make('critical')).event.severity).toBe('p1');
      expect(ec.processAlert(make('high')).event.severity).toBe('p2');
      expect(ec.processAlert(make('warning')).event.severity).toBe('p3');
      expect(ec.processAlert(make('unknown')).event.severity).toBe('p3');
    });
  });
});

/**
 * 事件列表必须能从 DB 读回（2026-10-25）
 *
 * 用户侧现象：哨兵页切走再回来 / 重启应用后，事件列表空白，详情入口消失
 * —— 看起来像「从来没监控过」。而库里事实上有几百条（实测未软删 335 条）。
 *
 * 成因：`listEvents()` 只遍历内存 Map，重启即空；DB 落盘事件从未被读回。
 * 正确语义：DB 提供全量事实，内存态覆盖同 id（本次进程的状态流转不得被 DB 盖回去）。
 */
describe('EventCenter.listEvents 读回 DB', () => {
  let db: Database.Database;
  let ec: EventCenter;

  beforeEach(() => {
    db = new Database(':memory:');
    const migrationsDir = path.resolve(__dirname, '../../../db/migrations');
    for (const f of fs.readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
      db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf-8'));
    }
    ec = new EventCenter(db);
  });

  afterEach(() => db.close());

  function insert(id: string, title: string, deleted = false): void {
    createSentinelEvent(db, {
      id,
      projectId: 'proj-1',
      timestamp: new Date('2026-10-20T10:00:00.000Z'),
      dedupeKey: `dk-${id}`,
      title,
      service: 'api',
      module: 'core',
      severity: 'p2',
      status: 'detected',
      validation: '{}',
      context: '{}',
      history: '[]',
      occurrenceCount: 1,
      firstSeen: new Date('2026-10-20T10:00:00.000Z'),
      lastSeen: new Date('2026-10-20T10:00:00.000Z'),
    });
    if (deleted) {
      db.prepare("UPDATE sentinel_events SET deleted_at = datetime('now') WHERE id = ?").run(id);
    }
  }

  it('内存为空时，DB 里的事件必须能列出来（重启后的回填路径）', () => {
    insert('e1', '库里的事件 1');
    insert('e2', '库里的事件 2');

    const events = ec.listEvents();
    expect(events).toHaveLength(2);
    // rowToEvent 必须把 JSON 字段还原成对象，否则页面拿到字符串会崩
    expect(Array.isArray(events[0].history)).toBe(true);
    expect(typeof events[0].context).toBe('object');
  });

  it('软删事件不进列表', () => {
    insert('alive', '活着');
    insert('gone', '已删', true);

    expect(ec.listEvents().map((e) => e.id)).toEqual(['alive']);
  });

  it('合并两侧：本次进程新建的事件与库里的历史事件同时可见', () => {
    insert('old', '库里的历史事件');
    const fresh = ec.createEvent({ projectId: 'proj-1', title: '本次新建' });

    const ids = ec.listEvents().map((e) => e.id);
    expect(ids).toContain('old');
    expect(ids).toContain(fresh.id);
  });

  it('筛选条件在合并后仍然生效', () => {
    insert('a', 'a');
    insert('b', 'b');
    db.prepare("UPDATE sentinel_events SET severity = 'p1' WHERE id = 'a'").run();

    expect(ec.listEvents({ severity: 'p1' }).map((e) => e.id)).toEqual(['a']);
  });
});
