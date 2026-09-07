import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger } from '../audit-logger';

let tmpHome: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

describe('AuditLogger 新增类别（orphan-cleanup / project-removal）', () => {
  let logger: AuditLogger;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-audit-test-'));
    logger = new AuditLogger();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function readLines(category: string): Array<Record<string, unknown>> {
    const dateStr = new Date().toISOString().slice(0, 10);
    const file = path.join(tmpHome, '.zhshield', 'audit', category, `${dateStr}.jsonl`);
    const content = fs.readFileSync(file, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('logOrphanCleanup 写入 orphan-cleanup 目录，含 timestamp 与传入字段，逐行 JSON', async () => {
    await logger.logOrphanCleanup({
      action: 'confirmed',
      projectId: 'proj-1',
      reason: 'no longer referenced',
    });

    const lines = readLines('orphan-cleanup');
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.timestamp).toBeDefined();
    expect(new Date(entry.timestamp as string).getTime()).not.toBeNaN();
    expect(entry.action).toBe('confirmed');
    expect(entry.projectId).toBe('proj-1');
    expect(entry.reason).toBe('no longer referenced');
  });

  it('logOrphanCleanup 支持多种 action 值', async () => {
    await logger.logOrphanCleanup({ action: 'purged', projectId: 'proj-2' });
    const lines = readLines('orphan-cleanup');
    expect(lines[0].action).toBe('purged');
  });

  it('logProjectRemoval 写入 project-removal 目录，含 timestamp 与传入字段，逐行 JSON', async () => {
    await logger.logProjectRemoval({
      projectId: 'proj-9',
      ok: true,
      steps: [
        { step: 'remove-config', status: 'ok' },
        { step: 'remove-profiles', status: 'failed', error: 'permission denied' },
      ],
    });

    const lines = readLines('project-removal');
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.timestamp).toBeDefined();
    expect(new Date(entry.timestamp as string).getTime()).not.toBeNaN();
    expect(entry.projectId).toBe('proj-9');
    expect(entry.ok).toBe(true);
    expect(entry.steps).toEqual([
      { step: 'remove-config', status: 'ok' },
      { step: 'remove-profiles', status: 'failed', error: 'permission denied' },
    ]);
  });

  it('logProjectRemoval 支持失败场景（ok=false）', async () => {
    await logger.logProjectRemoval({ projectId: 'proj-10', ok: false });
    const lines = readLines('project-removal');
    expect(lines[0].ok).toBe(false);
  });

  it('两个新类别互不干扰，各自独立落盘', async () => {
    await logger.logOrphanCleanup({ action: 'suspected', projectId: 'a' });
    await logger.logProjectRemoval({ projectId: 'b', ok: true });

    expect(readLines('orphan-cleanup')).toHaveLength(1);
    expect(readLines('project-removal')).toHaveLength(1);
  });
});
