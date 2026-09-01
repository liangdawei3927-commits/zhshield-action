import { BackupOrchestrator } from '../backup/orchestrator';
import { GitHubBackup } from '../backup/github-backup';
import { LocalBackup } from '../backup/local-backup';

function createMockGitHubBackup(success: boolean): GitHubBackup {
  const mock = new GitHubBackup();
  mock.backup = async () =>
    success
      ? {
          type: 'github',
          success: true,
          commitHash: 'abc123',
          commitMessage: 'backup',
          repoUrl: 'https://github.com/mock/repo',
          branch: 'main',
        }
      : { type: 'github', success: false, error: 'github failed' };
  return mock;
}

function createMockLocalBackup(success: boolean): LocalBackup {
  const mock = new LocalBackup();
  mock.backup = async () =>
    success
      ? { type: 'local', success: true, backupPath: '/tmp/backup', size: 1000, fileCount: 10 }
      : { type: 'local', success: false, error: 'local failed' };
  return mock;
}

describe('BackupOrchestrator', () => {
  describe('execute', () => {
    it('runs enabled backups and returns success', async () => {
      const orchestrator = new BackupOrchestrator({
        githubBackup: createMockGitHubBackup(true),
        localBackup: createMockLocalBackup(true),
      });

      const result = await orchestrator.execute({
        projectId: 'test-project',
        projectPath: '/mock/path',
        projectName: 'Test Project',
        trigger: 'manual',
      });
      // local is enabled by default; github is disabled by default
      expect(result.overallStatus).toBe('success');
      expect(result.results.length).toBe(1);
      expect(result.results.every((r) => r.success)).toBe(true);
    });

    it('returns failed when all enabled backups fail', async () => {
      const orchestrator = new BackupOrchestrator({
        githubBackup: createMockGitHubBackup(false),
        localBackup: createMockLocalBackup(false),
      });

      const result = await orchestrator.execute({
        projectId: 'test-project',
        projectPath: '/mock/path',
      });
      expect(result.overallStatus).toBe('failed');
      expect(result.results.every((r) => !r.success)).toBe(true);
    });
  });

  describe('record management', () => {
    it('stores records after backup execution', async () => {
      const orchestrator = new BackupOrchestrator({
        githubBackup: createMockGitHubBackup(true),
        localBackup: createMockLocalBackup(true),
      });

      await orchestrator.execute({
        projectId: 'test-project',
        projectPath: '/mock/path',
        projectName: 'Test',
      });
      const records = orchestrator.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0].projectId).toBe('test-project');
    });

    it('filters records by project ID', async () => {
      const orchestrator = new BackupOrchestrator({
        githubBackup: createMockGitHubBackup(true),
        localBackup: createMockLocalBackup(true),
      });

      await orchestrator.execute({ projectId: 'project-a', projectPath: '/path/a' });
      await orchestrator.execute({ projectId: 'project-b', projectPath: '/path/b' });
      await orchestrator.execute({ projectId: 'project-a', projectPath: '/path/a' });

      expect(orchestrator.getRecords('project-a')).toHaveLength(2);
      expect(orchestrator.getRecords('project-b')).toHaveLength(1);
    });

    it('deletes a record by ID', async () => {
      const orchestrator = new BackupOrchestrator({
        githubBackup: createMockGitHubBackup(true),
        localBackup: createMockLocalBackup(true),
      });

      await orchestrator.execute({ projectId: 'test-project', projectPath: '/mock/path' });
      const records = orchestrator.getRecords();
      const deleted = orchestrator.deleteRecord(records[0].id);
      expect(deleted).toBe(true);
      expect(orchestrator.getRecords()).toHaveLength(0);
    });
  });
});
