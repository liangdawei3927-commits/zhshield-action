import { describe, it, expect, beforeEach } from 'vitest';
import { EventCenter } from '../event-center';
import { AutoFixer } from '../auto-fixer';

describe('AutoFixer', () => {
  let ec: EventCenter;
  let fixer: AutoFixer;

  beforeEach(() => {
    ec = new EventCenter();
    fixer = new AutoFixer(ec);
  });

  describe('lifecycle', () => {
    it('should not fix when not started', () => {
      const event = ec.createEvent({ projectId: 'proj-1', title: 'Not Started' });
      const result = fixer.evaluateAndFix(event);
      expect(result).toBe(false);
    });

    it('should start and stop', () => {
      fixer.start({ projectId: 'proj-1', projectPath: '/tmp', rules: [] });
      expect((fixer as unknown as { running: boolean }).running).toBe(true);
      fixer.stop();
      expect((fixer as unknown as { running: boolean }).running).toBe(false);
    });
  });

  describe('evaluateAndFix', () => {
    it('should update-status action successfully', () => {
      const event = ec.createEvent({ projectId: 'proj-1', title: 'Status Test', dedupeKey: 'dk-status' });
      fixer.start({
        projectId: 'proj-1',
        projectPath: '/tmp',
        rules: [{
          name: 'status-update',
          eventFilter: () => true,
          actions: [{ type: 'update-status', params: { status: 'fixing' } }],
        }],
      });

      const result = fixer.evaluateAndFix(event);
      expect(result).toBe(true);

      const updated = ec.getEvent(event.id);
      expect(updated!.status).toBe('pr_opened');
    });

    it('should exhaust max attempts', () => {
      const event = ec.createEvent({ projectId: 'proj-1', title: 'Exhaust Test', dedupeKey: 'dk-exhaust' });
      fixer.start({
        projectId: 'proj-1',
        projectPath: '/tmp',
        rules: [{
          name: 'exhaust-test',
          eventFilter: () => true,
          actions: [{ type: 'run-script', params: { script: 'exit 1' } }],
          maxAttempts: 2,
        }],
      });

      fixer.evaluateAndFix(event);
      fixer.evaluateAndFix(event);
      const result = fixer.evaluateAndFix(event);
      expect(result).toBe(false);

      const events = ec.listEvents();
      const exhausted = events.find((e) => e.title.includes('exhausted'));
      expect(exhausted).toBeDefined();
    });

    it('should not match non-matching rules', () => {
      const event = ec.createEvent({ projectId: 'proj-1', title: 'No Match', severity: 'p3', dedupeKey: 'dk-nomatch' });
      fixer.start({
        projectId: 'proj-1',
        projectPath: '/tmp',
        rules: [{
          name: 'p1-only',
          eventFilter: (e) => e.severity === 'p1',
          actions: [{ type: 'update-status', params: { status: 'fixing' } }],
        }],
      });

      const result = fixer.evaluateAndFix(event);
      expect(result).toBe(false);
    });
  });
});
