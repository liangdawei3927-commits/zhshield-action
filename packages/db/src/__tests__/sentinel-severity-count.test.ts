/**
 * 哨兵事件按 severity 计数（评分取数）。
 *
 * 锁三件事，每条都对应一个会直接改分数的错误：
 * 1) **软删事件必须排除** —— `listSentinelEvents` 本身不带 `deleted_at IS NULL`，
 *    本函数是评分取数的专用入口，必须自带该条件（否则清理过的旧事件永久拖着分数）；
 * 2) **终态事件（passed/merged/deployed）不计入** —— 已处理完的告警不该继续扣分；
 * 3) **不受 LIMIT 截断** —— 用 `GROUP BY` 计数，`listSentinelEvents` 默认只取 100 条，
 *    事件一多就少算（本项目实测 288 条，截断会直接少算 188 条）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  createSentinelEvent,
  countSentinelEventsBySeverity,
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

const PROJECT = '/tmp/proj-a';
const OTHER = '/tmp/proj-b';

function addEvent(
  db: Database.Database,
  id: string,
  severity: 'p1' | 'p2' | 'p3',
  status = 'detected',
  projectId = PROJECT,
): void {
  createSentinelEvent(db, {
    id,
    projectId,
    timestamp: new Date('2026-10-23T10:00:00.000Z'),
    dedupeKey: `k-${id}`,
    title: `t-${id}`,
    service: 'svc',
    module: 'mod',
    severity,
    status,
    validation: '{}',
    context: '{}',
    history: '[]',
    occurrenceCount: 1,
    firstSeen: new Date('2026-10-23T10:00:00.000Z'),
    lastSeen: new Date('2026-10-23T10:00:00.000Z'),
  });
}

describe('countSentinelEventsBySeverity', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it('按 severity 分组计数，且只算本项目', () => {
    addEvent(db, 'a1', 'p1');
    addEvent(db, 'a2', 'p2');
    addEvent(db, 'a3', 'p2');
    addEvent(db, 'a4', 'p3');
    addEvent(db, 'b1', 'p1', 'detected', OTHER);

    const c = countSentinelEventsBySeverity(db, PROJECT);
    expect(c).toEqual({ p1: 1, p2: 2, p3: 1, total: 4 });
  });

  it('软删事件不计入（deleted_at IS NULL 必须生效）', () => {
    addEvent(db, 'a1', 'p1');
    addEvent(db, 'a2', 'p2');
    softDeleteProjectData(db, PROJECT);
    expect(countSentinelEventsBySeverity(db, PROJECT).total).toBe(0);
  });

  it('终态事件（已处理）不计入', () => {
    addEvent(db, 'a1', 'p2');
    addEvent(db, 'a2', 'p2', 'passed');
    addEvent(db, 'a3', 'p1', 'merged');
    const c = countSentinelEventsBySeverity(db, PROJECT, {
      excludeStatuses: ['passed', 'merged', 'deployed'],
    });
    expect(c).toEqual({ p1: 0, p2: 1, p3: 0, total: 1 });
  });

  it('事件数远超 100 也不被截断（listSentinelEvents 默认 LIMIT 100）', () => {
    for (let i = 0; i < 250; i += 1) addEvent(db, `e${i}`, 'p2');
    expect(countSentinelEventsBySeverity(db, PROJECT).p2).toBe(250);
  });
});
