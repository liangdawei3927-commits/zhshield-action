import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {
  createProject,
  saveScore,
  saveScanResult,
  saveExperience,
  createSentinelEvent,
  saveDebtAction,
  saveDebtSnapshot,
  softDeleteProjectData,
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

/** 读取某表某 project_id 行的 deleted_at（无行返回 undefined） */
function deletedAtOf(db: Database.Database, table: string, projectId: string): unknown {
  const row = db
    .prepare(`SELECT deleted_at FROM ${table} WHERE project_id = ? LIMIT 1`)
    .get(projectId) as { deleted_at: unknown } | undefined;
  return row?.deleted_at;
}

const PROJECT_DATA_TABLES = [
  'scores',
  'scanning_results',
  'debt_actions',
  'debt_snapshots',
  'sentinel_events',
] as const;

describe('012 soft delete migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('adds deleted_at column to all 5 project-data tables', () => {
    for (const table of PROJECT_DATA_TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const col = cols.find((c) => c.name === 'deleted_at');
      expect(col, `${table} should have deleted_at`).toBeDefined();
    }
  });

  it('does NOT add deleted_at to experiences', () => {
    const cols = db.prepare('PRAGMA table_info(experiences)').all() as Array<{ name: string }>;
    expect(cols.find((c) => c.name === 'deleted_at')).toBeUndefined();
  });
});

describe('softDeleteProjectData', () => {
  let db: Database.Database;
  const now = new Date('2026-07-29T12:00:00Z');

  beforeEach(() => {
    db = createTestDb();
  });

  it('marks all 5 project-data tables for the project', () => {
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });

    saveScore(db, {
      projectId: 'proj-1',
      overall: 85,
      grade: 'B',
      dimensions: '{}',
      trend: 'improving',
    });
    saveScanResult(db, { projectId: 'proj-1', source: 'eslint', passed: true, summary: 'OK' });
    saveDebtAction(db, {
      projectId: 'proj-1',
      actionId: 'a-1',
      status: 'pending',
      module: 'm',
      category: 'c',
      issueIds: ['i1'],
      interestScore: 1,
      principalEstimate: 2,
      roi: 3,
    });
    saveDebtSnapshot(db, { projectId: 'proj-1', debtIndex: 1 });
    createSentinelEvent(db, {
      id: 'evt-1',
      projectId: 'proj-1',
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

    softDeleteProjectData(db, '/test');

    for (const table of PROJECT_DATA_TABLES) {
      expect(deletedAtOf(db, table, 'proj-1'), `${table} should be soft-deleted`).not.toBeNull();
    }
  });

  it('does NOT touch experiences for the same project', () => {
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
    saveExperience(db, {
      id: 'exp-1',
      projectId: 'proj-1',
      ruleId: 'RULE-001',
      type: 'true-positive',
    });

    softDeleteProjectData(db, '/test');

    // experiences 无 deleted_at 列(012 刻意不加,L70-73 已验证)且行原样保留
    const row = db
      .prepare('SELECT id, project_id, rule_id, type FROM experiences WHERE id = ?')
      .get('exp-1') as { id: string; project_id: string; rule_id: string; type: string } | undefined;
    expect(row).toEqual({
      id: 'exp-1',
      project_id: 'proj-1',
      rule_id: 'RULE-001',
      type: 'true-positive',
    });
  });

  it('is a safe no-op for a path with no projects row and no orphan rows', () => {
    // desktop 从不写 projects 表（008），无行且无孤儿数据时不应抛错
    expect(() => softDeleteProjectData(db, '/not-in-db')).not.toThrow();
  });

  it('desktop path: cleans orphan rows by projectPath when no projects row exists', () => {
    // 桌面场景实证：从不写 projects 表（008），写入键控 project_id = projectPath
    // getProjectByPath 恒 undefined → 应按 path 直接清理 5 表孤儿行
    const desktopPath = '/Users/test/my-project';
    saveScore(db, {
      projectId: desktopPath,
      overall: 70,
      grade: 'C',
      dimensions: '{}',
      trend: 'stable',
    });
    saveScanResult(db, { projectId: desktopPath, source: 'eslint', passed: true, summary: 'OK' });
    saveDebtAction(db, {
      projectId: desktopPath,
      actionId: 'da-1',
      status: 'pending',
      module: 'm',
      category: 'c',
      issueIds: ['i1'],
      interestScore: 1,
      principalEstimate: 2,
      roi: 3,
    });
    saveDebtSnapshot(db, { projectId: desktopPath, debtIndex: 5 });
    createSentinelEvent(db, {
      id: 'evt-desktop-1',
      projectId: desktopPath,
      timestamp: now,
      dedupeKey: 'dk-desktop-1',
      title: 'Warning',
      service: 'api',
      module: 'core',
      severity: 'p2',
      status: 'detected',
      validation: '{}',
      context: '{}',
      history: '[]',
      occurrenceCount: 1,
      firstSeen: now,
      lastSeen: now,
    });

    // 无 projects 行：桌面路径不写 projects 表
    expect(db.prepare('SELECT * FROM projects WHERE path = ?').get(desktopPath)).toBeUndefined();

    softDeleteProjectData(db, desktopPath);

    // 5 表孤儿行全部被打上 deleted_at
    for (const table of PROJECT_DATA_TABLES) {
      expect(
        deletedAtOf(db, table, desktopPath),
        `${table} should be soft-deleted by desktop path`,
      ).not.toBeNull();
    }
  });

  it('only marks rows whose deleted_at is currently NULL (idempotent)', () => {
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
    saveScore(db, {
      projectId: 'proj-1',
      overall: 85,
      grade: 'B',
      dimensions: '{}',
      trend: 'improving',
    });

    softDeleteProjectData(db, '/test');
    const first = deletedAtOf(db, 'scores', 'proj-1');
    softDeleteProjectData(db, '/test');
    const second = deletedAtOf(db, 'scores', 'proj-1');

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });
});
