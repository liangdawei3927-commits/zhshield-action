import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {
  createProject,
  getProject,
  saveScore,
  getScoreHistory,
  getLatestScanResult,
  listExperiences,
  getSentinelEvent,
  getDebtActionsByProject,
  getLatestDebtSnapshot,
} from '../queries';
import {
  createProjectsBatch,
  saveScoresBatch,
  saveScanResultsBatch,
  saveExperiencesBatch,
  createSentinelEventsBatch,
  saveDebtActionsBatch,
  saveDebtSnapshotsBatch,
} from '../batch';

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

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
}

describe('Batch writes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('createProjectsBatch inserts N rows', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `proj-${i}`,
      name: `P${i}`,
      path: `/p${i}`,
    }));
    createProjectsBatch(db, rows);
    expect(count(db, 'projects')).toBe(5);
    expect(getProject(db, 'proj-3')!.name).toBe('P3');
  });

  it('saveScoresBatch inserts N rows', () => {
    createProject(db, { id: 'proj-1', name: 'T', path: '/t' });
    const rows = Array.from({ length: 10 }, (_, i) => ({
      projectId: 'proj-1',
      overall: 70 + i,
      grade: 'B' as const,
      dimensions: '{}',
      trend: 'improving' as const,
    }));
    saveScoresBatch(db, rows);
    expect(count(db, 'scores')).toBe(10);
    expect(getScoreHistory(db, 'proj-1')).toHaveLength(10);
  });

  it('saveScanResultsBatch inserts N rows', () => {
    createProject(db, { id: 'proj-1', name: 'T', path: '/t' });
    const rows = Array.from({ length: 4 }, (_, i) => ({
      projectId: 'proj-1',
      source: `src-${i}`,
      passed: i % 2 === 0,
      summary: 'ok',
    }));
    saveScanResultsBatch(db, rows);
    expect(count(db, 'scanning_results')).toBe(4);
    expect(getLatestScanResult(db, 'proj-1', 'src-3')!.passed).toBe(0);
  });

  it('saveExperiencesBatch inserts N rows', () => {
    createProject(db, { id: 'proj-1', name: 'T', path: '/t' });
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `exp-${i}`,
      projectId: 'proj-1',
      ruleId: 'R',
      type: 'true-positive' as const,
    }));
    saveExperiencesBatch(db, rows);
    expect(count(db, 'experiences')).toBe(3);
    expect(listExperiences(db)).toHaveLength(3);
  });

  it('createSentinelEventsBatch inserts N rows', () => {
    createProject(db, { id: 'proj-1', name: 'T', path: '/t' });
    const now = new Date('2026-07-29T12:00:00Z');
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `evt-${i}`,
      projectId: 'proj-1',
      timestamp: now,
      dedupeKey: `dk-${i}`,
      title: 't',
      service: 'api',
      module: 'core',
      severity: 'p1' as const,
      status: 'detected',
      validation: '{}',
      context: '{}',
      history: '[]',
      occurrenceCount: 1,
      firstSeen: now,
      lastSeen: now,
    }));
    createSentinelEventsBatch(db, rows);
    expect(count(db, 'sentinel_events')).toBe(3);
    expect(getSentinelEvent(db, 'evt-2')!.title).toBe('t');
  });

  it('saveDebtActionsBatch inserts N rows', () => {
    createProject(db, { id: 'proj-1', name: 'T', path: '/t' });
    const rows = Array.from({ length: 3 }, (_, i) => ({
      projectId: 'proj-1',
      actionId: `a-${i}`,
      status: 'pending' as const,
      module: 'm',
      category: 'c',
      issueIds: ['i1'],
      interestScore: 1,
      principalEstimate: 2,
      roi: 3,
    }));
    saveDebtActionsBatch(db, rows);
    expect(count(db, 'debt_actions')).toBe(3);
    expect(getDebtActionsByProject(db, 'proj-1')).toHaveLength(3);
  });

  it('saveDebtSnapshotsBatch inserts N rows', () => {
    createProject(db, { id: 'proj-1', name: 'T', path: '/t' });
    const rows = Array.from({ length: 3 }, (_, i) => ({ projectId: 'proj-1', debtIndex: i }));
    saveDebtSnapshotsBatch(db, rows);
    expect(count(db, 'debt_snapshots')).toBe(3);
    expect(getLatestDebtSnapshot(db, 'proj-1')!.debt_index).toBe(2);
  });

  it('rolls back entire batch when a row fails (all-or-nothing)', () => {
    createProject(db, { id: 'proj-1', name: 'T', path: '/t' });
    const rows = [
      {
        projectId: 'proj-1',
        overall: 80,
        grade: 'B' as const,
        dimensions: '{}',
        trend: 'improving' as const,
      },
      {
        projectId: 'proj-1',
        overall: 50,
        grade: 'E' as unknown as 'A' | 'B' | 'C' | 'D',
        dimensions: '{}',
        trend: 'improving' as const,
      },
    ];
    expect(() => saveScoresBatch(db, rows)).toThrow();
    expect(count(db, 'scores')).toBe(0);
  });

  it('rolls back entire batch on duplicate primary key', () => {
    const rows = [
      { id: 'proj-1', name: 'A', path: '/a' },
      { id: 'proj-1', name: 'B', path: '/b' },
    ];
    expect(() => createProjectsBatch(db, rows)).toThrow();
    expect(count(db, 'projects')).toBe(0);
  });

  it('batch insert is equivalent to repeated single-row inserts', () => {
    createProject(db, { id: 'proj-1', name: 'T', path: '/t' });
    const rows = Array.from({ length: 5 }, (_, i) => ({
      projectId: 'proj-1',
      overall: 60 + i,
      grade: 'B' as const,
      dimensions: '{}',
      trend: 'improving' as const,
    }));
    saveScoresBatch(db, rows);
    for (const r of rows) saveScore(db, r);
    const history = getScoreHistory(db, 'proj-1');
    expect(history).toHaveLength(10);
    // created_at 为秒级精度，同秒内排序不保证插入顺序；按 overall 排序后比对全集
    const overalls = history.map((s) => s.overall).sort((a, b) => a - b);
    const expected = [...rows.map((r) => r.overall), ...rows.map((r) => r.overall)].sort(
      (a, b) => a - b,
    );
    expect(overalls).toEqual(expected);
  });

  it('empty batch is a no-op', () => {
    createProject(db, { id: 'proj-1', name: 'T', path: '/t' });
    saveScoresBatch(db, []);
    expect(count(db, 'scores')).toBe(0);
  });
});
