import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../audit/audit-logger';

describe('AuditLogger', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'zhshield-audit-test-'));
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  describe('log deduplication (M7)', () => {
    it('returns the existing entry when the last entry is identical within the 1s window', async () => {
      const logger = new AuditLogger(logDir);

      const first = await logger.log('deploy', 'user-1', { env: 'prod' });
      const second = await logger.log('deploy', 'user-1', { env: 'prod' });

      expect(second.id).toBe(first.id);
      const entries = await logger.query({});
      expect(entries).toHaveLength(1);
    });

    it('writes a new entry when details differ from the last entry', async () => {
      const logger = new AuditLogger(logDir);

      await logger.log('deploy', 'user-1', { env: 'prod' });
      await logger.log('deploy', 'user-1', { env: 'staging' });

      const entries = await logger.query({});
      expect(entries).toHaveLength(2);
    });

    it('writes a new entry when the matching last entry is older than 1s', async () => {
      writeFileSync(join(logDir, 'audit-001.jsonl'), '', 'utf-8');
      const stale = {
        id: 'audit_stale',
        timestamp: new Date(Date.now() - 2000).toISOString(),
        action: 'deploy',
        userId: 'user-1',
        details: { env: 'prod' },
        previousHash: '',
        hash: 'stale-hash',
      };
      appendFileSync(join(logDir, 'audit-001.jsonl'), JSON.stringify(stale) + '\n', 'utf-8');

      const logger = new AuditLogger(logDir);
      const entry = await logger.log('deploy', 'user-1', { env: 'prod' });

      expect(entry.id).not.toBe('audit_stale');
      const entries = await logger.query({});
      expect(entries).toHaveLength(2);
    });
  });

  describe('concurrent writes (M11)', () => {
    it('keeps the hash chain valid when many log() calls race', async () => {
      const logger = new AuditLogger(logDir);

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => logger.log('scan', `user-${i}`, { index: i })),
      );

      const entries = await logger.query({ limit: 1000 });
      expect(entries).toHaveLength(20);
      expect(new Set(results.map(r => r.id)).size).toBe(20);
      const integrity = await logger.verifyIntegrity();
      expect(integrity.valid).toBe(true);
    });

    it('chains sequential entries onto each other and stays verifiable', async () => {
      const logger = new AuditLogger(logDir);

      const first = await logger.log('a', 'u', {});
      const second = await logger.log('b', 'u', {});

      expect(second.previousHash).toBe(first.hash);
      const integrity = await logger.verifyIntegrity();
      expect(integrity.valid).toBe(true);
    });
  });
});
