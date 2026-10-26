/**
 * listMergedEvents 的 projectId 过滤回归（2026-10-26）。
 *
 * 缺陷背景：事件表是多项目共用的，`listMergedEvents` 原先**不过滤项目**，
 * 哨兵页把别的项目的待处理事件显示到当前项目名下，而评分卡按项目算分
 * ⇒「3 个问题却 100 分」的口径分裂（实测：外层项目页面显示内层的 3 条 p2）。
 *
 * 修复：projectId 必须同时约束 DB 查询（下推 SQL）与内存事件；内存里
 * projectId 不匹配的事件即使 id 更新也不得回填。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createSentinelEvent } from '@zh/db';
import { listMergedEvents, rowToEvent, LIST_EVENTS_LIMIT } from '../event-list';
import type { SentinelEvent } from '../types';

function createTestDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-sentinel-list-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  const migrationsDir = path.resolve(__dirname, '../../../db/migrations');
  for (const f of fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf-8'));
  }
  return db;
}

const PROJ_A = '/tmp/proj-a';
const PROJ_B = '/tmp/proj-b';

function seedEvent(
  db: Database.Database,
  id: string,
  projectId: string,
  timestamp: string,
): void {
  createSentinelEvent(db, {
    id,
    projectId,
    dedupeKey: `dk-${id}`,
    title: id,
    service: 'test',
    module: 'test',
    severity: 'p2',
    status: 'detected',
    timestamp: new Date(timestamp),
    validation: '{}',
    context: '{}',
    history: '[]',
    occurrenceCount: 1,
    firstSeen: new Date(timestamp),
    lastSeen: new Date(timestamp),
  });
}

function eventOf(id: string, projectId: string): SentinelEvent {
  return {
    id,
    projectId,
    timestamp: new Date('2026-10-26T10:00:00Z'),
    dedupeKey: `dk-${id}`,
    title: id,
    service: 'test',
    module: 'test',
    severity: 'p2',
    status: 'detected',
    validation: null,
    context: null,
    history: [],
    occurrenceCount: 1,
    firstSeen: new Date('2026-10-26T10:00:00Z'),
    lastSeen: new Date('2026-10-26T10:00:00Z'),
  };
}

describe('listMergedEvents projectId 过滤', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedEvent(db, 'db-a1', PROJ_A, '2026-10-26T10:00:00Z');
    seedEvent(db, 'db-b1', PROJ_B, '2026-10-26T11:00:00Z');
  });

  afterAll(() => {
    db.close();
  });

  it('按 projectId 只返回该项目的事件（DB 侧下推 SQL）', () => {
    const rows = listMergedEvents(db, new Map(), { projectId: PROJ_A });
    expect(rows.map((e) => e.id)).toEqual(['db-a1']);
  });

  it('内存事件同样按 projectId 过滤，且不回填他项目同 id', () => {
    const dbRow = db
      .prepare('SELECT * FROM sentinel_events WHERE id = ?')
      .get('db-a1') as Parameters<typeof rowToEvent>[0];
    const memory = new Map<string, SentinelEvent>([
      // 同项目：内存态（已流转 passed）应覆盖 DB
      ['db-a1', { ...rowToEvent(dbRow), status: 'passed' }],
      // 他项目：即使 id 不同也不得混入
      ['mem-b1', eventOf('mem-b1', PROJ_B)],
    ]);
    const rows = listMergedEvents(db, memory, { projectId: PROJ_A });
    expect(rows.map((e) => e.id)).toEqual(['db-a1']);
    expect(rows[0]?.status).toBe('passed');
  });

  it('不传 projectId 保持全量（向后兼容调用方）', () => {
    const rows = listMergedEvents(db, new Map());
    expect(rows.map((e) => e.id).sort()).toEqual(['db-a1', 'db-b1']);
  });

  it('LIST_EVENTS_LIMIT 常量存在且为正（分页上限不回退）', () => {
    expect(LIST_EVENTS_LIMIT).toBeGreaterThan(0);
  });
});
