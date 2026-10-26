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

/**
 * saveScore 现在把 project_id 归一化为绝对路径（相对路径按 cwd resolve），
 * 本文件所有评分/扫描键统一用该常量，与生产契约「project_id 必须绝对」对齐。
 */
const SCORE_PROJ = path.resolve('proj-1');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Run all migrations
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const fs = require('fs');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
  }
  return db;
}

describe('Projects CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

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
    const ids = projects.map((p) => p.id);
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
    saveScore(db, {
      projectId: SCORE_PROJ,
      overall: 85,
      grade: 'B',
      dimensions: '{}',
      trend: 'improving',
    });
    const score = getLatestScore(db, SCORE_PROJ);
    expect(score).toBeDefined();
    expect(score!.overall).toBe(85);
    expect(score!.grade).toBe('B');
    expect(score!.trend).toBe('improving');
  });

  it('should retrieve most recent score when multiple exist', () => {
    saveScore(db, {
      projectId: SCORE_PROJ,
      overall: 60,
      grade: 'D',
      dimensions: '{}',
      trend: 'declining',
    });
    saveScore(db, {
      projectId: SCORE_PROJ,
      overall: 90,
      grade: 'A',
      dimensions: '{}',
      trend: 'improving',
    });
    const latest = getLatestScore(db, SCORE_PROJ);
    expect(latest!.overall).toBe(90);
  });

  it('should return score history with limit', () => {
    for (let i = 0; i < 5; i++) {
      saveScore(db, {
        projectId: SCORE_PROJ,
        overall: 70 + i,
        grade: 'B',
        dimensions: '{}',
        trend: 'improving',
      });
    }
    const history = getScoreHistory(db, SCORE_PROJ, 3);
    expect(history).toHaveLength(3);
  });

  it('should reject invalid grade', () => {
    expect(() => {
      saveScore(db, {
        projectId: SCORE_PROJ,
        overall: 50,
        grade: 'E' as unknown as 'A' | 'B' | 'C' | 'D',
        dimensions: '{}',
        trend: 'improving',
      });
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
    saveScanResult(db, { projectId: SCORE_PROJ, source: 'eslint', passed: true, summary: 'All ok' });
    const result = getLatestScanResult(db, SCORE_PROJ, 'eslint');
    expect(result).toBeDefined();
    expect(result!.passed).toBe(1);
    expect(result!.summary).toBe('All ok');
  });

  it('should save scan result with report', () => {
    saveScanResult(db, {
      projectId: SCORE_PROJ,
      source: 'trivy',
      passed: false,
      summary: '2 vulns',
      report: '{"vulns":[]}',
    });
    const result = getLatestScanResult(db, SCORE_PROJ, 'trivy');
    expect(result!.report).toBe('{"vulns":[]}');
  });

  it('should list scan results filtered by source', () => {
    saveScanResult(db, { projectId: SCORE_PROJ, source: 'eslint', passed: true, summary: 'OK' });
    saveScanResult(db, { projectId: SCORE_PROJ, source: 'trivy', passed: false, summary: 'FAIL' });
    const results = listScanResults(db, SCORE_PROJ, 'eslint');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('eslint');
  });

  it('should list all scan results for a project', () => {
    saveScanResult(db, { projectId: SCORE_PROJ, source: 'eslint', passed: true, summary: 'OK' });
    saveScanResult(db, { projectId: SCORE_PROJ, source: 'trivy', passed: true, summary: 'OK' });
    const results = listScanResults(db, SCORE_PROJ);
    expect(results).toHaveLength(2);
  });
});

describe('Rules CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should insert and retrieve a rule', () => {
    upsertRule(db, {
      ruleId: 'RULE-001',
      state: 'active',
      weight: 1.5,
      reason: 'Important',
      changedBy: 'admin',
    });
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
    saveExperience(db, {
      id: 'exp-1',
      projectId: SCORE_PROJ,
      ruleId: 'RULE-001',
      type: 'true-positive',
      detail: 'Found real bug',
      source: 'user',
    });
    const list = listExperiences(db);
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('true-positive');
  });

  it('should filter experiences by project and rule', () => {
    saveExperience(db, {
      id: 'exp-1',
      projectId: SCORE_PROJ,
      ruleId: 'RULE-001',
      type: 'true-positive',
    });
    saveExperience(db, {
      id: 'exp-2',
      projectId: SCORE_PROJ,
      ruleId: 'RULE-002',
      type: 'false-positive',
    });
    const filtered = listExperiences(db, SCORE_PROJ, 'RULE-001');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rule_id).toBe('RULE-001');
  });

  it('should get experience stats for a rule', () => {
    saveExperience(db, {
      id: 'exp-1',
      projectId: SCORE_PROJ,
      ruleId: 'RULE-001',
      type: 'true-positive',
    });
    saveExperience(db, {
      id: 'exp-2',
      projectId: SCORE_PROJ,
      ruleId: 'RULE-001',
      type: 'true-positive',
    });
    saveExperience(db, {
      id: 'exp-3',
      projectId: SCORE_PROJ,
      ruleId: 'RULE-001',
      type: 'false-positive',
    });
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
      id: 'evt-1',
      projectId: SCORE_PROJ,
      timestamp: now,
      dedupeKey: 'dk-1',
      title: 'Server Error',
      service: 'api',
      module: 'auth',
      severity: 'p1',
      status: 'detected',
      validation: '{}',
      context: '{}',
      history: '[]',
      occurrenceCount: 1,
      firstSeen: now,
      lastSeen: now,
    });
    const event = getSentinelEvent(db, 'evt-1');
    expect(event).toBeDefined();
    expect(event!.title).toBe('Server Error');
    expect(event!.severity).toBe('p1');
    expect(event!.occurrence_count).toBe(1);
  });

  it('should update event status', () => {
    createSentinelEvent(db, {
      id: 'evt-1',
      projectId: SCORE_PROJ,
      timestamp: now,
      dedupeKey: 'dk-1',
      title: 'Error',
      service: 'api',
      module: 'auth',
      severity: 'p2',
      status: 'detected',
      validation: '{}',
      context: '{}',
      history: '[]',
      occurrenceCount: 1,
      firstSeen: now,
      lastSeen: now,
    });
    updateSentinelEvent(db, {
      id: 'evt-1',
      status: 'resolved',
      occurrenceCount: 3,
      lastSeen: new Date('2026-07-29T13:00:00Z'),
    });
    const updated = getSentinelEvent(db, 'evt-1');
    expect(updated!.status).toBe('resolved');
  });

  it('should find event by dedupe key', () => {
    createSentinelEvent(db, {
      id: 'evt-1',
      projectId: SCORE_PROJ,
      timestamp: now,
      dedupeKey: 'unique-error',
      title: 'Memory Leak',
      service: 'api',
      module: 'cache',
      severity: 'p1',
      status: 'detected',
      validation: '{}',
      context: '{}',
      history: '[]',
      occurrenceCount: 1,
      firstSeen: now,
      lastSeen: now,
    });
    const found = findSentinelEventByDedupeKey(db, 'unique-error');
    expect(found).toBeDefined();
    expect(found!.title).toBe('Memory Leak');
  });

  it('should list events with filters', () => {
    for (const sev of ['p1', 'p2', 'p3'] as const) {
      createSentinelEvent(db, {
        id: `evt-${sev}`,
        projectId: SCORE_PROJ,
        timestamp: now,
        dedupeKey: `dk-${sev}`,
        title: `${sev} event`,
        service: 'api',
        module: 'core',
        severity: sev,
        status: 'detected',
        validation: '{}',
        context: '{}',
        history: '[]',
        occurrenceCount: 1,
        firstSeen: now,
        lastSeen: now,
      });
    }
    const p1events = listSentinelEvents(db, { severity: 'p1' });
    expect(p1events).toHaveLength(1);
    expect(p1events[0].severity).toBe('p1');
  });

  it('should return stats', () => {
    for (const sev of ['p1', 'p1', 'p2'] as const) {
      createSentinelEvent(db, {
        id: `evt-${Math.random()}`,
        projectId: SCORE_PROJ,
        timestamp: now,
        dedupeKey: `dk-${Math.random()}`,
        title: 'test',
        service: 'api',
        module: 'core',
        severity: sev,
        status: 'detected',
        validation: '{}',
        context: '{}',
        history: '[]',
        occurrenceCount: 1,
        firstSeen: now,
        lastSeen: now,
      });
    }
    const stats = getSentinelEventStats(db);
    expect(stats.total).toBe(3);
    expect(stats.severity_p1).toBe(2);
    expect(stats.severity_p2).toBe(1);
  });

  it('should delete an event', () => {
    createSentinelEvent(db, {
      id: 'evt-del',
      projectId: SCORE_PROJ,
      timestamp: now,
      dedupeKey: 'dk-del',
      title: 'To Delete',
      service: 'api',
      module: 'core',
      severity: 'p3',
      status: 'detected',
      validation: '{}',
      context: '{}',
      history: '[]',
      occurrenceCount: 1,
      firstSeen: now,
      lastSeen: now,
    });
    deleteSentinelEvent(db, 'evt-del');
    expect(getSentinelEvent(db, 'evt-del')).toBeUndefined();
  });

  /**
   * 软删事件不得对外（2026-10-25）。
   *
   * 实测桌面库：sentinel_events 共 38144 行，其中 37809 行已软删、只有 335 行活着。
   * `listSentinelEvents` 不带 `deleted_at IS NULL` 时，默认 `LIMIT 100` 取回的几乎
   * 全是已删除的历史噪音 —— 哨兵页接上 DB 回填后会显示一堆"用户已经删掉"的事件。
   */
  it('listSentinelEvents 不返回软删事件', () => {
    const mk = (id: string): void => {
      createSentinelEvent(db, {
        id,
        projectId: SCORE_PROJ,
        timestamp: now,
        dedupeKey: `dk-${id}`,
        title: id,
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
    };
    mk('alive-1');
    mk('gone-1');
    db.prepare("UPDATE sentinel_events SET deleted_at = datetime('now') WHERE id = ?").run('gone-1');

    const ids = listSentinelEvents(db).map((r) => r.id);
    expect(ids).toContain('alive-1');
    expect(ids).not.toContain('gone-1');
  });

  it('去重查询跳过软删事件（删掉的那条不该继续抑制同类新事件）', () => {
    createSentinelEvent(db, {
      id: 'dup-1',
      projectId: SCORE_PROJ,
      timestamp: now,
      dedupeKey: 'same-key',
      title: 'dup',
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
    expect(findSentinelEventByDedupeKey(db, 'same-key')).toBeDefined();

    db.prepare("UPDATE sentinel_events SET deleted_at = datetime('now') WHERE id = ?").run('dup-1');
    expect(findSentinelEventByDedupeKey(db, 'same-key')).toBeUndefined();
  });
});

describe('Foreign key relaxation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should accept score for project without projects row (008_relax_fk)', () => {
    // saveScore 会把相对路径归一化，这里显式用绝对路径键（无 projects 行）
    saveScore(db, {
      projectId: SCORE_PROJ,
      overall: 85,
      grade: 'B',
      dimensions: '{}',
      trend: 'improving',
    });

    const score = getLatestScore(db, SCORE_PROJ);
    expect(score).toBeDefined();
    expect(score!.overall).toBe(85);
  });

  it('should accept scanning result for project without projects row (008_relax_fk)', () => {
    expect(() => {
      saveScanResult(db, {
        projectId: 'nonexistent',
        source: 'eslint',
        passed: true,
        summary: 'OK',
      });
    }).not.toThrow();
  });
});

describe('Empty states', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

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

/**
 * project_id 写入归一化（2026-10-26）：评分历史的 project_id 锚定绝对路径，
 * CLI 从子目录执行时曾透传相对 cwd 路径落库成死行（真库实测 75 条 `packages/xxx`）。
 */
describe('saveScore 的 project_id 归一化', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('相对路径按 cwd 解析为绝对路径落库', () => {
    saveScore(db, {
      projectId: 'packages/demo',
      overall: 90,
      grade: 'A',
      dimensions: '[]',
      trend: 'stable',
    });
    const rows = db.prepare('SELECT project_id FROM scores').all() as { project_id: string }[];
    expect(rows).toHaveLength(1);
    expect(path.isAbsolute(rows[0].project_id)).toBe(true);
    expect(rows[0].project_id).toBe(path.resolve('packages/demo'));
  });

  it('绝对路径原样落库（不二次解析）', () => {
    saveScore(db, {
      projectId: '/tmp/zh-absolute-demo',
      overall: 90,
      grade: 'A',
      dimensions: '[]',
      trend: 'stable',
    });
    const rows = db.prepare('SELECT project_id FROM scores').all() as { project_id: string }[];
    expect(rows[0].project_id).toBe('/tmp/zh-absolute-demo');
  });
});
