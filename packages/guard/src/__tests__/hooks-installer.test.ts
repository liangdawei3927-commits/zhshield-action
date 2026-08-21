import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HooksInstaller } from '../hooks-installer';
import * as fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      access: vi.fn().mockResolvedValue(undefined),
    },
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

describe('HooksInstaller', () => {
  const testDir = '/tmp/test-hooks-installer';
  let installer: HooksInstaller;

  beforeEach(() => {
    installer = new HooksInstaller(testDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── install ───────────────────────────────────────────

  describe('install', () => {
    it('should create hooks directory before writing', async () => {
      await installer.install();
      expect(fs.promises.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('.git/hooks'),
        { recursive: true },
      );
    });

    it('should write pre-commit hook script with zhshield command', async () => {
      await installer.install('pre-commit');
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('pre-commit'),
        expect.stringContaining('zhshield guard --hook=pre-commit'),
        expect.objectContaining({ mode: 0o755 }),
      );
    });

    it('should write pre-push hook script', async () => {
      await installer.install('pre-push');
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('pre-push'),
        expect.stringContaining('zhshield guard --hook=pre-push'),
        expect.objectContaining({ mode: 0o755 }),
      );
    });

    it('should write post-commit hook script', async () => {
      await installer.install('post-commit');
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('post-commit'),
        expect.stringContaining('post-commit'),
        expect.objectContaining({ mode: 0o755 }),
      );
    });

    it('should install all hooks when no name specified', async () => {
      const installed = await installer.install();
      expect(installed).toEqual(['pre-commit', 'pre-push', 'post-commit']);
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(3);
    });

    it('should install only matching hook when name specified', async () => {
      const installed = await installer.install('pre-push');
      expect(installed).toEqual(['pre-push']);
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
    });

    it('should return empty array for non-existent hook name', async () => {
      const installed = await installer.install('nonexistent');
      expect(installed).toEqual([]);
    });
  });

  // ─── uninstall ─────────────────────────────────────────

  describe('uninstall', () => {
    it('should remove matching hook file', async () => {
      const removed = await installer.uninstall('pre-commit');
      expect(removed).toEqual(['pre-commit']);
      expect(fs.promises.unlink).toHaveBeenCalledWith(
        expect.stringContaining('pre-commit'),
      );
    });

    it('should remove all hooks when no name specified', async () => {
      const removed = await installer.uninstall();
      expect(removed).toEqual(['pre-commit', 'pre-push', 'post-commit']);
      expect(fs.promises.unlink).toHaveBeenCalledTimes(3);
    });

    it('should silently ignore missing hook files', async () => {
      vi.mocked(fs.promises.unlink).mockRejectedValueOnce(new Error('ENOENT'));
      const removed = await installer.uninstall('pre-commit');
      expect(removed).toEqual([]);
    });
  });

  // ─── isInstalled ───────────────────────────────────────

  describe('isInstalled', () => {
    it('should return true when all requested hooks are accessible', async () => {
      vi.mocked(fs.promises.access).mockResolvedValue(undefined);
      const result = await installer.isInstalled('pre-commit');
      expect(result).toBe(true);
    });

    it('should return false when any hook is not accessible', async () => {
      vi.mocked(fs.promises.access).mockRejectedValueOnce(new Error('ENOENT'));
      const result = await installer.isInstalled('pre-commit');
      expect(result).toBe(false);
    });

    it('should check all hooks when no name specified', async () => {
      const result = await installer.isInstalled();
      expect(result).toBe(true);
      expect(fs.promises.access).toHaveBeenCalledTimes(3);
    });
  });

  // ─── hasGitDir ─────────────────────────────────────────

  describe('hasGitDir', () => {
    it('should return true when .git directory exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(installer.hasGitDir()).toBe(true);
    });

    it('should return false when .git directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(installer.hasGitDir()).toBe(false);
    });
  });

  // ─── listInstalledHooks ────────────────────────────────

  describe('listInstalledHooks', () => {
    it('should return hook names that match known hooks', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['pre-commit', 'pre-push', 'other-file'] as unknown as fs.Dirent[]);
      const hooks = installer.listInstalledHooks();
      expect(hooks).toEqual(['pre-commit', 'pre-push']);
    });

    it('should return empty array when hooks directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const hooks = installer.listInstalledHooks();
      expect(hooks).toEqual([]);
    });

    it('should return empty array on read error', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('permission denied'); });
      const hooks = installer.listInstalledHooks();
      expect(hooks).toEqual([]);
    });
  });
});
