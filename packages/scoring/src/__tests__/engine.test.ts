import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { unlinkSync } from 'fs';
import { DbConnection, createProject, getProjectByPath } from '@zh/db';
import { ScoringEngine } from '../engine';

function createScoringEngine(inMemory = true) {
  if (inMemory) {
    return new ScoringEngine();
  }
  // Persistent mode — uses a temporary SQLite database
  const tmpFile = `/tmp/zh-scoring-test-${Date.now()}.db`;
  const conn = new DbConnection({ dbPath: tmpFile });
  const db = conn.connect();
  conn.migrate(resolve(__dirname, '..', '..', '..', 'db', 'migrations'));
  return { engine: new ScoringEngine(db), db, conn, dbPath: tmpFile };
}

function ensureProject(db: import('better-sqlite3').Database, id: string, path = `/tmp/${id}`) {
  if (!getProjectByPath(db, path)) {
    createProject(db, { id, name: id, path });
  }
}

describe('ScoringEngine (in-memory)', () => {
  it('calculates a score from dimension scores', () => {
    const engine = createScoringEngine(true);
    const score = engine.calculate('project-a', [
      { name: 'quality', score: 90, weight: 0.4, issues: 1 },
      { name: 'security', score: 85, weight: 0.3, issues: 2 },
      { name: 'performance', score: 80, weight: 0.3, issues: 0 },
    ]);

    // 90*0.4 + 85*0.3 + 80*0.3 = 36 + 25.5 + 24 = 85.5
    expect(score.overall).toBe(85.5);
    expect(score.grade).toBe('B');
    expect(score.dimensions).toHaveLength(3);
    expect(score.projectId).toBe('project-a');
  });

  it('assigns grade A for scores >= 90', () => {
    const engine = createScoringEngine(true);
    const score = engine.calculate('pa', [
      { name: 'quality', score: 95, weight: 0.5, issues: 0 },
      { name: 'security', score: 90, weight: 0.5, issues: 0 },
    ]);
    expect(score.overall).toBe(92.5);
    expect(score.grade).toBe('A');
  });

  it('assigns grade C for scores between 60 and 74', () => {
    const engine = createScoringEngine(true);
    const score = engine.calculate('pa', [
      { name: 'quality', score: 60, weight: 0.5, issues: 10 },
      { name: 'security', score: 70, weight: 0.5, issues: 5 },
    ]);
    expect(score.overall).toBe(65);
    expect(score.grade).toBe('C');
  });

  it('assigns grade D for scores < 60', () => {
    const engine = createScoringEngine(true);
    const score = engine.calculate('pa', [
      { name: 'quality', score: 40, weight: 0.5, issues: 20 },
      { name: 'security', score: 50, weight: 0.5, issues: 15 },
    ]);
    expect(score.overall).toBe(45);
    expect(score.grade).toBe('D');
  });

  it('tracks score history', () => {
    const engine = createScoringEngine(true);
    engine.calculate('ph', [{ name: 'x', score: 80, weight: 1, issues: 0 }]);
    engine.calculate('ph', [{ name: 'x', score: 85, weight: 1, issues: 0 }]);
    engine.calculate('ph', [{ name: 'x', score: 90, weight: 1, issues: 0 }]);

    const history = engine.getHistory('ph');
    expect(history).toHaveLength(3);
    expect(history[0].overall).toBe(80);
    expect(history[2].overall).toBe(90);
  });

  it('detects improving trend', () => {
    const engine = createScoringEngine(true);
    engine.calculate('pt', [{ name: 'x', score: 70, weight: 1, issues: 0 }]);
    const s2 = engine.calculate('pt', [{ name: 'x', score: 85, weight: 1, issues: 0 }]);
    expect(s2.trend).toBe('improving');
  });

  it('detects declining trend', () => {
    const engine = createScoringEngine(true);
    engine.calculate('pt', [{ name: 'x', score: 85, weight: 1, issues: 0 }]);
    const s2 = engine.calculate('pt', [{ name: 'x', score: 70, weight: 1, issues: 0 }]);
    expect(s2.trend).toBe('declining');
  });

  it('returns stable for first score', () => {
    const engine = createScoringEngine(true);
    const score = engine.calculate('new', [{ name: 'x', score: 80, weight: 1, issues: 0 }]);
    expect(score.trend).toBe('stable');
  });

  it('returns current score', () => {
    const engine = createScoringEngine(true);
    engine.calculate('pc', [{ name: 'x', score: 70, weight: 1, issues: 0 }]);
    engine.calculate('pc', [{ name: 'x', score: 88, weight: 1, issues: 0 }]);
    const current = engine.getCurrent('pc');
    expect(current?.overall).toBe(88);
  });

  it('returns undefined for unknown project', () => {
    const engine = createScoringEngine(true);
    expect(engine.getCurrent('nonexistent')).toBeUndefined();
    expect(engine.getHistory('nonexistent')).toEqual([]);
  });

  it('generates trend report with improving trend', () => {
    const engine = createScoringEngine(true);
    for (let i = 0; i < 5; i++) {
      engine.calculate('tr', [{ name: 'quality', score: 60 + i * 5, weight: 1, issues: 0 }]);
    }
    const report = engine.getTrendReport('tr');
    expect(report.overallTrend).toBe('improving');
    expect(report.velocity).toBeGreaterThan(0);
    expect(report.dimensionTrends).toHaveLength(1);
    expect(report.dimensionTrends[0].name).toBe('quality');
    expect(report.insights.length).toBeGreaterThan(0);
  });

  it('generates trend report with declining trend', () => {
    const engine = createScoringEngine(true);
    for (let i = 0; i < 5; i++) {
      engine.calculate('tr2', [{ name: 'security', score: 90 - i * 5, weight: 1, issues: 0 }]);
    }
    const report = engine.getTrendReport('tr2');
    expect(report.overallTrend).toBe('declining');
    expect(report.velocity).toBeLessThan(0);
  });

  it('returns empty report for unknown project', () => {
    const engine = createScoringEngine(true);
    const report = engine.getTrendReport('nonexistent');
    expect(report.overallTrend).toBe('stable');
    expect(report.current).toBeNull();
    expect(report.insights[0]).toContain('暂无历史数据');
  });

  it('computes volatility correctly', () => {
    const engine = createScoringEngine(true);
    const scores = [80, 90, 70, 95, 65];
    for (const s of scores) {
      engine.calculate('vol', [{ name: 'x', score: s, weight: 1, issues: 0 }]);
    }
    const report = engine.getTrendReport('vol');
    expect(report.volatility).toBeGreaterThan(0);
  });

  it('computes streak correctly', () => {
    const engine = createScoringEngine(true);
    for (let i = 0; i < 4; i++) {
      engine.calculate('streak', [{ name: 'x', score: 70 + i * 5, weight: 1, issues: 0 }]);
    }
    const report = engine.getTrendReport('streak');
    expect(report.streak.direction).toBe('improving');
    expect(report.streak.count).toBeGreaterThanOrEqual(3);
  });
});

describe('ScoringEngine (persistent)', () => {
  it('persists scores to SQLite', () => {
    const { engine, db, conn, dbPath } = createScoringEngine(false);

    try {
      ensureProject(db, 'persist-proj');
      engine.calculate('persist-proj', [
        { name: 'quality', score: 85, weight: 0.5, issues: 1 },
        { name: 'security', score: 90, weight: 0.5, issues: 0 },
      ]);

      const current = engine.getCurrent('persist-proj');
      expect(current?.overall).toBe(87.5);
      expect(current?.grade).toBe('B');

      // history should include the persisted entry
      const history = engine.getHistory('persist-proj');
      expect(history.length).toBeGreaterThanOrEqual(1);
    } finally {
      conn.close();
      try {
        unlinkSync(dbPath);
      } catch {}
    }
  });

  it('computes trend from persisted history', () => {
    const { engine, db, conn, dbPath } = createScoringEngine(false);

    try {
      ensureProject(db, 'trend-proj');
      engine.calculate('trend-proj', [{ name: 'x', score: 70, weight: 1, issues: 0 }]);
      const s2 = engine.calculate('trend-proj', [{ name: 'x', score: 85, weight: 1, issues: 0 }]);
      expect(s2.trend).toBe('improving');
    } finally {
      conn.close();
      try {
        unlinkSync(dbPath);
      } catch {}
    }
  });
});
