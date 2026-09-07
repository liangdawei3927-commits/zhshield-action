import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {
  createProject,
  saveScore,
  saveScanResult,
  saveDebtAction,
  saveDebtSnapshot,
  createSentinelEvent,
  softDeleteProjectData,
  listActiveProjectIds,
  listSoftDeletedProjectIds,
  purgeExpiredSoftDeleted,
  countActiveRows,
} from '../queries';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
  }
  return db;
}

const PROJECT_DATA_TABLES = [
  'scores',
  'scanning_results',
  'debt_actions',
  'debt_snapshots',
  'sentinel_events',
] as const;

const now = new Date('2026-09-07T10:00:00Z');

describe('listActiveProjectIds', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns [] when no data exists', () => {
    expect(listActiveProjectIds(db)).toEqual([]);
  });

  it('returns project_ids that have active (non-soft-deleted) rows', () => {
    saveScore(db, {
      projectId: 'p1',
      overall: 80,
      grade: 'B',
      dimensions: '{}',
      trend: 'stable',
    });
    saveScanResult(db, { projectId: 'p1', source: 'eslint', passed: true, summary: 'OK' });

    const ids = listActiveProjectIds(db);
    expect(ids).toContain('p1');
  });

  it('excludes soft-deleted rows', () => {
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
    saveScore(db, {
      projectId: 'proj-1',
      overall: 80,
      grade: 'B',
      dimensions: '{}',
      trend: 'stable',
    });

    softDeleteProjectData(db, '/test');

    expect(listActiveProjectIds(db)).not.toContain('proj-1');
  });

  it('UNION deduplicates across tables', () => {
    saveScore(db, {
      projectId: 'p1',
      overall: 80,
      grade: 'B',
      dimensions: '{}',
      trend: 'stable',
    });
    saveScanResult(db, { projectId: 'p1', source: 'eslint', passed: true, summary: 'OK' });
    saveDebtAction(db, {
      projectId: 'p1',
      actionId: 'a1',
      status: 'pending',
      module: 'm',
      category: 'c',
      issueIds: ['i1'],
      interestScore: 1,
      principalEstimate: 2,
      roi: 3,
    });
    saveDebtSnapshot(db, { projectId: 'p1', debtIndex: 1 });
    createSentinelEvent(db, {
      id: 'evt-1',
      projectId: 'p1',
      timestamp: now,
      dedupeKey: 'dk-1',
      title: 'Error',
      service: 'api',
      module: 'core',
      severity: 'p1',
      status: 'detected',
      validation: '{}',
      context: '{}',
      history: '[]',
      occurrenceCount: 1,
      firstSeen: now,
      lastSeen: now,
    });

    const ids = listActiveProjectIds(db);
    const p1Count = ids.filter((id) => id === 'p1').length;
    expect(p1Count).toBe(1);
  });
});

describe('listSoftDeletedProjectIds', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns [] when no soft-deleted data exists', () => {
    expect(listSoftDeletedProjectIds(db)).toEqual([]);
  });

  it('returns project_ids that have soft-deleted rows', () => {
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
    saveScore(db, {
      projectId: 'proj-1',
      overall: 80,
      grade: 'B',
      dimensions: '{}',
      trend: 'stable',
    });

    softDeleteProjectData(db, '/test');

    const ids = listSoftDeletedProjectIds(db);
    expect(ids).toContain('proj-1');
  });

  it('excludes active (non-deleted) rows', () => {
    saveScore(db, {
      projectId: 'p1',
      overall: 80,
      grade: 'B',
      dimensions: '{}',
      trend: 'stable',
    });

    expect(listSoftDeletedProjectIds(db)).not.toContain('p1');
  });

  it('UNION deduplicates across tables', () => {
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
    saveScore(db, {
      projectId: 'proj-1',
      overall: 80,
      grade: 'B',
      dimensions: '{}',
      trend: 'stable',
    });
    saveScanResult(db, { projectId: 'proj-1', source: 'eslint', passed: true, summary: 'OK' });

    softDeleteProjectData(db, '/test');

    const ids = listSoftDeletedProjectIds(db);
    const proj1Count = ids.filter((id) => id === 'proj-1').length;
    expect(proj1Count).toBe(1);
  });
});

describe('purgeExpiredSoftDeleted', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns 0 deleted for each table when no soft-deleted rows exist', () => {
    const results = purgeExpiredSoftDeleted(db, 30);
    expect(results).toHaveLength(PROJECT_DATA_TABLES.length);
    for (const r of results) {
      expect(r.deleted).toBe(0);
    }
  });

  it('deletes rows older than ttlDays and keeps recent ones', () => {
    const oldDate = new Date('2026-06-01T00:00:00.000Z');
    const recentDate = new Date();

    db.prepare(
      `INSERT INTO scores (project_id, overall, grade, dimensions, trend, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('p-old', 50, 'D', '{}', 'declining', oldDate.toISOString());

    db.prepare(
      `INSERT INTO scores (project_id, overall, grade, dimensions, trend, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('p-recent', 80, 'B', '{}', 'stable', recentDate.toISOString());

    const results = purgeExpiredSoftDeleted(db, 30);
    const scoresResult = results.find((r) => r.table === 'scores')!;
    expect(scoresResult.deleted).toBe(1);

    const remaining = db
      .prepare('SELECT project_id FROM scores WHERE deleted_at IS NOT NULL')
      .all() as { project_id: string }[];
    expect(remaining.map((r) => r.project_id)).toContain('p-recent');
    expect(remaining.map((r) => r.project_id)).not.toContain('p-old');
  });

  it('ISO 8601 format is correctly compared (the format trap)', () => {
    const isoDate = '2026-06-01T00:00:00.000Z';

    db.prepare(
      `INSERT INTO scores (project_id, overall, grade, dimensions, trend, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('p-iso', 50, 'D', '{}', 'declining', isoDate);

    const results = purgeExpiredSoftDeleted(db, 30);
    const scoresResult = results.find((r) => r.table === 'scores')!;
    expect(scoresResult.deleted).toBe(1);

    const remaining = db
      .prepare('SELECT project_id FROM scores WHERE deleted_at IS NOT NULL')
      .all() as { project_id: string }[];
    expect(remaining.map((r) => r.project_id)).not.toContain('p-iso');
  });

  it('ttlDays boundary: exactly N days ago is NOT purged, N+1 days ago IS purged', () => {
    const ref = new Date();
    // 边界行：恰好 30 天前（+1 分钟缓冲，确保晚于执行时的 cutoff，不被清除）
    const exactlyNDaysAgo = new Date(ref.getTime() - 30 * 24 * 60 * 60 * 1000 + 60 * 1000);
    // 刚过 30 天（-1 分钟缓冲，确保早于 cutoff，被清除）
    const oneMoreDayAgo = new Date(ref.getTime() - 30 * 24 * 60 * 60 * 1000 - 60 * 1000);

    db.prepare(
      `INSERT INTO debt_actions (project_id, action_id, status, module, category, issue_ids, interest_score, principal_estimate, roi, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('p-boundary', 'a1', 'pending', 'm', 'c', '[]', 1, 2, 3, exactlyNDaysAgo.toISOString());

    db.prepare(
      `INSERT INTO debt_actions (project_id, action_id, status, module, category, issue_ids, interest_score, principal_estimate, roi, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('p-old-boundary', 'a2', 'pending', 'm', 'c', '[]', 1, 2, 3, oneMoreDayAgo.toISOString());

    const results = purgeExpiredSoftDeleted(db, 30);
    const debtResult = results.find((r) => r.table === 'debt_actions')!;
    expect(debtResult.deleted).toBe(1);

    const remaining = db
      .prepare('SELECT project_id FROM debt_actions WHERE deleted_at IS NOT NULL')
      .all() as { project_id: string }[];
    expect(remaining.map((r) => r.project_id)).toContain('p-boundary');
    expect(remaining.map((r) => r.project_id)).not.toContain('p-old-boundary');
  });

  it('purged rows do not affect listActiveProjectIds', () => {
    const oldDate = new Date('2026-01-01T00:00:00.000Z');

    db.prepare(
      `INSERT INTO scores (project_id, overall, grade, dimensions, trend, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('p-purge', 50, 'D', '{}', 'declining', oldDate.toISOString());

    saveScore(db, {
      projectId: 'p-active',
      overall: 80,
      grade: 'B',
      dimensions: '{}',
      trend: 'stable',
    });

    expect(listActiveProjectIds(db)).toContain('p-active');

    purgeExpiredSoftDeleted(db, 30);

    expect(listActiveProjectIds(db)).toContain('p-active');
    expect(listActiveProjectIds(db)).not.toContain('p-purge');
  });

  it('purges across all 5 tables in a single call', () => {
    const oldDate = new Date('2026-01-01T00:00:00.000Z');

    db.prepare(
      `INSERT INTO scores (project_id, overall, grade, dimensions, trend, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('p-all', 50, 'D', '{}', 'declining', oldDate.toISOString());

    db.prepare(
      `INSERT INTO scanning_results (project_id, source, passed, summary, deleted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('p-all', 'eslint', 1, 'OK', oldDate.toISOString());

    db.prepare(
      `INSERT INTO debt_actions (project_id, action_id, status, module, category, issue_ids, interest_score, principal_estimate, roi, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('p-all', 'a1', 'pending', 'm', 'c', '[]', 1, 2, 3, oldDate.toISOString());

    db.prepare(
      `INSERT INTO debt_snapshots (project_id, debt_index, deleted_at)
       VALUES (?, ?, ?)`,
    ).run('p-all', 10, oldDate.toISOString());

    db.prepare(
      `INSERT INTO sentinel_events (id, project_id, timestamp, dedupe_key, title, service, module, severity, status, validation, context, history, occurrence_count, first_seen, last_seen, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('evt-purge', 'p-all', oldDate.toISOString(), 'dk-purge', 'E', 'api', 'core', 'p1', 'detected', '{}', '{}', '[]', 1, oldDate.toISOString(), oldDate.toISOString(), oldDate.toISOString());

    const results = purgeExpiredSoftDeleted(db, 30);
    for (const r of results) {
      expect(r.deleted).toBe(1);
    }
  });
});

describe('countActiveRows', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns [] when no data exists for the project', () => {
    expect(countActiveRows(db, 'nonexistent')).toEqual([]);
  });

  it('counts active (non-deleted) rows per table', () => {
    saveScore(db, {
      projectId: 'p1',
      overall: 80,
      grade: 'B',
      dimensions: '{}',
      trend: 'stable',
    });
    saveScore(db, {
      projectId: 'p1',
      overall: 90,
      grade: 'A',
      dimensions: '{}',
      trend: 'improving',
    });
    saveScanResult(db, { projectId: 'p1', source: 'eslint', passed: true, summary: 'OK' });

    const counts = countActiveRows(db, 'p1');
    expect(counts).toContainEqual({ table: 'scores', count: 2 });
    expect(counts).toContainEqual({ table: 'scanning_results', count: 1 });
  });

  it('excludes soft-deleted rows from count', () => {
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
    saveScore(db, {
      projectId: 'proj-1',
      overall: 80,
      grade: 'B',
      dimensions: '{}',
      trend: 'stable',
    });
    saveScanResult(db, { projectId: 'proj-1', source: 'eslint', passed: true, summary: 'OK' });

    softDeleteProjectData(db, '/test');

    const counts = countActiveRows(db, 'proj-1');
    expect(counts).toEqual([]);
  });

  it('only includes tables with count > 0', () => {
    saveScore(db, {
      projectId: 'p1',
      overall: 80,
      grade: 'B',
      dimensions: '{}',
      trend: 'stable',
    });

    const counts = countActiveRows(db, 'p1');
    expect(counts).toHaveLength(1);
    expect(counts[0].table).toBe('scores');
    expect(counts[0].count).toBe(1);
  });
});
