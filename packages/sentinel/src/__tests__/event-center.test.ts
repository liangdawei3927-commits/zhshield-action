import { describe, it, expect, beforeEach } from 'vitest';
import { EventCenter } from '../event-center';

describe('EventCenter', () => {
  let ec: EventCenter;

  beforeEach(() => {
    ec = new EventCenter();
  });

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
        alerts: [{
          fingerprint: 'fp-1',
          labels: {
            alertname: 'ServerError',
            service: 'api',
            module: 'auth',
            severity: 'critical',
            repo: 'proj-1',
          },
          annotations: { summary: 'Server 500 errors detected' },
        }],
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
        alerts: [{
          fingerprint: 'fp-dedup',
          labels: {
            alertname: 'DedupTest',
            service: 'api',
            module: 'core',
            severity: 'high',
            repo: 'proj-1',
          },
          annotations: { summary: 'Dedup test' },
        }],
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
        alerts: [{
          fingerprint: `fp-${sev}`,
          labels: { alertname: 'test', service: 'api', module: 'core', severity: sev, repo: 'p' },
          annotations: { summary: 'test' },
        }],
      });
      expect(ec.processAlert(make('critical')).event.severity).toBe('p1');
      expect(ec.processAlert(make('high')).event.severity).toBe('p2');
      expect(ec.processAlert(make('warning')).event.severity).toBe('p3');
      expect(ec.processAlert(make('unknown')).event.severity).toBe('p3');
    });
  });
});
