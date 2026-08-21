import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {
  createProject,
  saveDebtAction,
  updateDebtActionStatus,
  getDebtActionsByProject,
  saveDebtSnapshot,
  getLatestDebtSnapshot,
} from '../queries';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
  }
  return db;
}

function makeSaveParams(overrides?: Partial<Parameters<typeof saveDebtAction>[1]>) {
  return {
    projectId: 'proj-1',
    actionId: 'td-security-abc123',
    status: 'pending' as const,
    module: 'src/api/auth.ts',
    category: 'security',
    issueIds: ['i1', 'i2'],
    interestScore: 18.5,
    principalEstimate: 4,
    roi: 4.63,
    sprint: undefined,
    gate: undefined,
    ...overrides,
  };
}

describe('Debt Actions CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
  });

  it('saveDebtAction inserts a row and getDebtActionsByProject returns it', () => {
    saveDebtAction(db, makeSaveParams());
    const rows = getDebtActionsByProject(db, 'proj-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].action_id).toBe('td-security-abc123');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].issue_ids).toBe(JSON.stringify(['i1', 'i2']));
    expect(rows[0].interest_score).toBe(18.5);
    expect(rows[0].principal_estimate).toBe(4);
    expect(rows[0].sprint).toBeNull();
  });

  it('saveDebtAction upserts on conflict (project_id, action_id)', () => {
    saveDebtAction(db, makeSaveParams({ status: 'pending' }));
    saveDebtAction(db, makeSaveParams({ status: 'planned', sprint: 'S23', gate: 'allow-with-record' }));
    const rows = getDebtActionsByProject(db, 'proj-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('planned');
    expect(rows[0].sprint).toBe('S23');
    expect(rows[0].gate).toBe('allow-with-record');
  });

  it('updateDebtActionStatus changes status', () => {
    saveDebtAction(db, makeSaveParams());
    updateDebtActionStatus(db, { projectId: 'proj-1', actionId: 'td-security-abc123', status: 'repaid' });
    const rows = getDebtActionsByProject(db, 'proj-1');
    expect(rows[0].status).toBe('repaid');
  });

  it('getDebtActionsByProject returns empty for unknown project', () => {
    expect(getDebtActionsByProject(db, 'unknown')).toEqual([]);
  });

  it('multiple actions per project', () => {
    saveDebtAction(db, makeSaveParams({ actionId: 'td-security-abc' }));
    saveDebtAction(db, makeSaveParams({ actionId: 'td-quality-def', category: 'quality', module: 'src/util.ts' }));
    const rows = getDebtActionsByProject(db, 'proj-1');
    expect(rows).toHaveLength(2);
  });
});

describe('Debt Snapshots CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
  });

  it('saveDebtSnapshot + getLatestDebtSnapshot returns most recent', () => {
    saveDebtSnapshot(db, { projectId: 'proj-1', debtIndex: 42 });
    saveDebtSnapshot(db, { projectId: 'proj-1', debtIndex: 35 });
    const latest = getLatestDebtSnapshot(db, 'proj-1');
    expect(latest).toBeDefined();
    expect(latest!.debt_index).toBe(35);
    expect(latest!.project_id).toBe('proj-1');
  });

  it('getLatestDebtSnapshot returns undefined when empty', () => {
    expect(getLatestDebtSnapshot(db, 'proj-1')).toBeUndefined();
  });

  it('snapshots are project-scoped', () => {
    createProject(db, { id: 'proj-2', name: 'Other', path: '/other' });
    saveDebtSnapshot(db, { projectId: 'proj-1', debtIndex: 42 });
    saveDebtSnapshot(db, { projectId: 'proj-2', debtIndex: 10 });
    expect(getLatestDebtSnapshot(db, 'proj-1')!.debt_index).toBe(42);
    expect(getLatestDebtSnapshot(db, 'proj-2')!.debt_index).toBe(10);
  });
});
