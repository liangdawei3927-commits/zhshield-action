import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import {
  createProject,
  getProject,
  getProjectByPath,
  listProjects,
  deleteProject,
  saveScore,
  getLatestScore,
  getScoreHistory,
  saveScanResult,
  getLatestScanResult,
  listScanResults,
  upsertRule,
  getRule,
  listRules,
  saveExperience,
  listExperiences,
  getExperienceStats,
  createSentinelEvent,
  updateSentinelEvent,
  getSentinelEvent,
  findSentinelEventByDedupeKey,
  listSentinelEvents,
  deleteSentinelEvent,
  getSentinelEventStats,
} from '../queries';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Run all migrations
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const fs = require('fs');
  const files = fs.readdirSync(migrationsDir).filter((f: string) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
  }
  return db;
}

describe('Projects CRUD', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });

  it('should create and retrieve a project', () => {
    createProject(db, { id: 'proj-1', name: 'Test Project', path: '/test/path' });
    const project = getProject(db, 'proj-1');
    expect(project).toBeDefined();
    expect(project!.name).toBe('Test Project');
    expect(project!.path).toBe('/test/path');
  });

  it('should retrieve project by path', () => {
    createProject(db, { id: 'proj-1', name: 'Test', path: '/unique/path' });
    const project = getProjectByPath(db, '/unique/path');
    expect(project).toBeDefined();
    expect(project!.id).toBe('proj-1');
  });

  it('should return undefined for non-existent project', () => {
    expect(getProject(db, 'nonexistent')).toBeUndefined();
    expect(getProjectByPath(db, '/nonexistent')).toBeUndefined();
  });

  it('should list all projects', () => {
    createProject(db, { id: 'proj-1', name: 'First', path: '/first' });
    createProject(db, { id: 'proj-2', name: 'Second', path: '/second' });
    const projects = listProjects(db);
    expect(projects).toHaveLength(2);
    const ids = projects.map(p => p.id);
    expect(ids).toContain('proj-1');
    expect(ids).toContain('proj-2');
  });

  it('should delete a project', () => {
    createProject(db, { id: 'proj-1', name: 'To Delete', path: '/delete' });
    deleteProject(db, 'proj-1');
    expect(getProject(db, 'proj-1')).toBeUndefined();
  });

  it('should reject duplicate project id', () => {
    createProject(db, { id: 'proj-1', name: 'First', path: '/first' });
    expect(() => createProject(db, { id: 'proj-1', name: 'Duplicate', path: '/dup' })).toThrow();
  });
});

describe('Scores CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
  });

  it('should save and retrieve latest score', () => {
    saveScore(db, { projectId: 'proj-1', overall: 85, grade: 'B', dimensions: '{}', trend: 'improving' });
    const score = getLatestScore(db, 'proj-1');
    expect(score).toBeDefined();
    expect(score!.overall).toBe(85);
    expect(score!.grade).toBe('B');
    expect(score!.trend).toBe('improving');
  });

  it('should retrieve most recent score when multiple exist', () => {
    saveScore(db, { projectId: 'proj-1', overall: 60, grade: 'D', dimensions: '{}', trend: 'declining' });
    saveScore(db, { projectId: 'proj-1', overall: 90, grade: 'A', dimensions: '{}', trend: 'improving' });
    const latest = getLatestScore(db, 'proj-1');
    expect(latest!.overall).toBe(90);
  });

  it('should return score history with limit', () => {
    for (let i = 0; i < 5; i++) {
      saveScore(db, { projectId: 'proj-1', overall: 70 + i, grade: 'B', dimensions: '{}', trend: 'improving' });
    }
    const history = getScoreHistory(db, 'proj-1', 3);
    expect(history).toHaveLength(3);
  });

  it('should reject invalid grade', () => {
    expect(() => {
      saveScore(db, { projectId: 'proj-1', overall: 50, grade: 'E' as unknown as 'A' | 'B' | 'C' | 'D', dimensions: '{}', trend: 'improving' });
    }).toThrow();
  });
});

describe('Scanning Results CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
  });

  it('should save and retrieve scan result', () => {
    saveScanResult(db, { projectId: 'proj-1', source: 'eslint', passed: true, summary: 'All ok' });
    const result = getLatestScanResult(db, 'proj-1', 'eslint');
    expect(result).toBeDefined();
    expect(result!.passed).toBe(1);
    expect(result!.summary).toBe('All ok');
  });

  it('should save scan result with report', () => {
    saveScanResult(db, { projectId: 'proj-1', source: 'trivy', passed: false, summary: '2 vulns', report: '{"vulns":[]}' });
    const result = getLatestScanResult(db, 'proj-1', 'trivy');
    expect(result!.report).toBe('{"vulns":[]}');
  });

  it('should list scan results filtered by source', () => {
    saveScanResult(db, { projectId: 'proj-1', source: 'eslint', passed: true, summary: 'OK' });
    saveScanResult(db, { projectId: 'proj-1', source: 'trivy', passed: false, summary: 'FAIL' });
    const results = listScanResults(db, 'proj-1', 'eslint');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('eslint');
  });

  it('should list all scan results for a project', () => {
    saveScanResult(db, { projectId: 'proj-1', source: 'eslint', passed: true, summary: 'OK' });
    saveScanResult(db, { projectId: 'proj-1', source: 'trivy', passed: true, summary: 'OK' });
    const results = listScanResults(db, 'proj-1');
    expect(results).toHaveLength(2);
  });
});

describe('Rules CRUD', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });

  it('should insert and retrieve a rule', () => {
    upsertRule(db, { ruleId: 'RULE-001', state: 'active', weight: 1.5, reason: 'Important', changedBy: 'admin' });
    const rule = getRule(db, 'RULE-001');
    expect(rule).toBeDefined();
    expect(rule!.state).toBe('active');
    expect(rule!.weight).toBe(1.5);
  });

  it('should upsert (update) existing rule', () => {
    upsertRule(db, { ruleId: 'RULE-001', state: 'active', weight: 1.0 });
    upsertRule(db, { ruleId: 'RULE-001', state: 'deprecated', reason: 'Superseded' });
    const rule = getRule(db, 'RULE-001');
    expect(rule!.state).toBe('deprecated');
    expect(rule!.reason).toBe('Superseded');
    // Weight should be preserved from first insert since COALESCE uses original
    expect(rule!.weight).toBe(1.0);
  });

  it('should list all rules', () => {
    upsertRule(db, { ruleId: 'RULE-001', state: 'active' });
    upsertRule(db, { ruleId: 'RULE-002', state: 'disabled' });
    const rules = listRules(db);
    expect(rules).toHaveLength(2);
  });
});

describe('Experiences CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
  });

  it('should save and list experiences', () => {
    saveExperience(db, { id: 'exp-1', projectId: 'proj-1', ruleId: 'RULE-001', type: 'true-positive', detail: 'Found real bug', source: 'user' });
    const list = listExperiences(db);
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('true-positive');
  });

  it('should filter experiences by project and rule', () => {
    saveExperience(db, { id: 'exp-1', projectId: 'proj-1', ruleId: 'RULE-001', type: 'true-positive' });
    saveExperience(db, { id: 'exp-2', projectId: 'proj-1', ruleId: 'RULE-002', type: 'false-positive' });
    const filtered = listExperiences(db, 'proj-1', 'RULE-001');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rule_id).toBe('RULE-001');
  });

  it('should get experience stats for a rule', () => {
    saveExperience(db, { id: 'exp-1', projectId: 'proj-1', ruleId: 'RULE-001', type: 'true-positive' });
    saveExperience(db, { id: 'exp-2', projectId: 'proj-1', ruleId: 'RULE-001', type: 'true-positive' });
    saveExperience(db, { id: 'exp-3', projectId: 'proj-1', ruleId: 'RULE-001', type: 'false-positive' });
    const stats = getExperienceStats(db, 'RULE-001');
    expect(stats.total).toBe(3);
    expect(stats.truePositives).toBe(2);
    expect(stats.falsePositives).toBe(1);
  });
});

describe('Sentinel Events CRUD', () => {
  let db: Database.Database;
  const now = new Date('2026-07-29T12:00:00Z');

  beforeEach(() => {
    db = createTestDb();
    createProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
  });

  it('should create and retrieve an event', () => {
    createSentinelEvent(db, {
      id: 'evt-1', projectId: 'proj-1', timestamp: now, dedupeKey: 'dk-1',
      title: 'Server Error', service: 'api', module: 'auth',
      severity: 'p1', status: 'detected', validation: '{}', context: '{}',
      history: '[]', occurrenceCount: 1, firstSeen: now, lastSeen: now,
    });
    const event = getSentinelEvent(db, 'evt-1');
    expect(event).toBeDefined();
    expect(event!.title).toBe('Server Error');
    expect(event!.severity).toBe('p1');
    expect(event!.occurrence_count).toBe(1);
  });

  it('should update event status', () => {
    createSentinelEvent(db, {
      id: 'evt-1', projectId: 'proj-1', timestamp: now, dedupeKey: 'dk-1',
      title: 'Error', service: 'api', module: 'auth',
      severity: 'p2', status: 'detected', validation: '{}', context: '{}',
      history: '[]', occurrenceCount: 1, firstSeen: now, lastSeen: now,
    });
    updateSentinelEvent(db, { id: 'evt-1', status: 'resolved', occurrenceCount: 3, lastSeen: new Date('2026-07-29T13:00:00Z') });
    const updated = getSentinelEvent(db, 'evt-1');
    expect(updated!.status).toBe('resolved');
  });

  it('should find event by dedupe key', () => {
    createSentinelEvent(db, {
      id: 'evt-1', projectId: 'proj-1', timestamp: now, dedupeKey: 'unique-error',
      title: 'Memory Leak', service: 'api', module: 'cache',
      severity: 'p1', status: 'detected', validation: '{}', context: '{}',
      history: '[]', occurrenceCount: 1, firstSeen: now, lastSeen: now,
    });
    const found = findSentinelEventByDedupeKey(db, 'unique-error');
    expect(found).toBeDefined();
    expect(found!.title).toBe('Memory Leak');
  });

  it('should list events with filters', () => {
    for (const sev of ['p1', 'p2', 'p3'] as const) {
      createSentinelEvent(db, {
        id: `evt-${sev}`, projectId: 'proj-1', timestamp: now, dedupeKey: `dk-${sev}`,
        title: `${sev} event`, service: 'api', module: 'core',
        severity: sev, status: 'detected', validation: '{}', context: '{}',
        history: '[]', occurrenceCount: 1, firstSeen: now, lastSeen: now,
      });
    }
    const p1events = listSentinelEvents(db, { severity: 'p1' });
    expect(p1events).toHaveLength(1);
    expect(p1events[0].severity).toBe('p1');
  });

  it('should return stats', () => {
    for (const sev of ['p1', 'p1', 'p2'] as const) {
      createSentinelEvent(db, {
        id: `evt-${Math.random()}`, projectId: 'proj-1', timestamp: now, dedupeKey: `dk-${Math.random()}`,
        title: 'test', service: 'api', module: 'core',
        severity: sev, status: 'detected', validation: '{}', context: '{}',
        history: '[]', occurrenceCount: 1, firstSeen: now, lastSeen: now,
      });
    }
    const stats = getSentinelEventStats(db);
    expect(stats.total).toBe(3);
    expect(stats.severity_p1).toBe(2);
    expect(stats.severity_p2).toBe(1);
  });

  it('should delete an event', () => {
    createSentinelEvent(db, {
      id: 'evt-del', projectId: 'proj-1', timestamp: now, dedupeKey: 'dk-del',
      title: 'To Delete', service: 'api', module: 'core',
      severity: 'p3', status: 'detected', validation: '{}', context: '{}',
      history: '[]', occurrenceCount: 1, firstSeen: now, lastSeen: now,
    });
    deleteSentinelEvent(db, 'evt-del');
    expect(getSentinelEvent(db, 'evt-del')).toBeUndefined();
  });
});

describe('Foreign key enforcement', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });

  it('should reject score for non-existent project', () => {
    expect(() => {
      saveScore(db, { projectId: 'nonexistent', overall: 85, grade: 'B', dimensions: '{}', trend: 'improving' });
    }).toThrow();
  });
});

describe('Empty states', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });

  it('should return empty list for projects', () => {
    expect(listProjects(db)).toEqual([]);
  });

  it('should return undefined for non-existent score', () => {
    expect(getLatestScore(db, 'nonexistent')).toBeUndefined();
  });

  it('should return empty list for sentinel events', () => {
    expect(listSentinelEvents(db)).toEqual([]);
  });

  it('should return empty stats for sentinel events', () => {
    const stats = getSentinelEventStats(db);
    expect(stats.total).toBe(0);
  });
});
