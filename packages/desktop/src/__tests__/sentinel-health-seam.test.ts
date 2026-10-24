/**
 * 哨兵评分取数的「跨包接缝」验证（DB → 计数 → 评分口径）。
 *
 * 背景：2026-10-24 实测发现哨兵域恒 100 分 —— 库里本项目 288 条事件（p2 39 条），
 * 评分却读到 0 条。根因是取数走 `EventCenter.listEvents()`（**内存 Map**），
 * 落盘的事件一条也读不到；只有"本次进程刚好抓到事件"时才扣分
 * （实测 12 条评分里唯一一条 95.6 分，就是那次内存里有 1 条）。
 *
 * 锁三件事：
 * 1) **库里有事件 ⇒ 计数必须非零**（修复前这里恒为 0，是缺陷本身）；
 * 2) **未监控且从未有事件 ⇒ null**（按 not-run 处理，绝不当满分）；
 * 3) **调用边**：IPC 的 `getSentinelHealthData` 必须走 DB 取数，`listEvents()` 只能是
 *    DB 不可用时的回退 —— 只看符号是否存在会被骗（组件定义还在、调用已换）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { DbConnection, createSentinelEvent } from '@zh/db';
import { readSentinelHealthFromDb } from '../../electron/sentinel-health';

let tmpDir: string | null = null;
let connection: DbConnection | null = null;

// desktop 包不直接依赖 better-sqlite3（只有 @zh/db 依赖），故经 DbConnection 建库
async function createTestDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-sentinel-seam-'));
  const conn = new DbConnection({ dbPath: path.join(tmpDir, 'test.db') });
  const db = conn.connect();
  connection = conn;
  const migrationsDir = path.resolve(__dirname, '../../../db/migrations');
  if (fs.existsSync(migrationsDir)) await conn.migrate(migrationsDir);
  return db;
}

const PROJECT = '/Users/dawei/Desktop/ZHCodeShield';

function addEvent(db: Database.Database, id: string, severity: 'p1' | 'p2' | 'p3'): void {
  createSentinelEvent(db, {
    id,
    projectId: PROJECT,
    timestamp: new Date('2026-10-23T10:00:00.000Z'),
    dedupeKey: `k-${id}`,
    title: `t-${id}`,
    service: 'svc',
    module: 'mod',
    severity,
    status: 'detected',
    validation: '{}',
    context: '{}',
    history: '[]',
    occurrenceCount: 1,
    firstSeen: new Date('2026-10-23T10:00:00.000Z'),
    lastSeen: new Date('2026-10-23T10:00:00.000Z'),
  });
}

describe('哨兵取数必须落在 DB（不再读内存）', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => {
    connection?.close?.();
    connection = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('库里 39 条 p2 ⇒ warningEvents = 39（修复前恒为 0 ⇒ 哨兵恒 100 分）', () => {
    for (let i = 0; i < 39; i += 1) addEvent(db, `p2-${i}`, 'p2');
    for (let i = 0; i < 249; i += 1) addEvent(db, `p3-${i}`, 'p3');

    const health = readSentinelHealthFromDb(db, PROJECT, { monitoring: true });
    expect(health).not.toBeNull();
    expect(health!.warningEvents).toBe(39);
    expect(health!.criticalEvents).toBe(0);
    // p3 不计入扣分，但要能被统计到 total（说明取数确实读到了全量）
    expect(health!.total).toBe(288);
  });

  it('critical（p1）单独计数 —— 它同时决定红线压制', () => {
    addEvent(db, 'c1', 'p1');
    addEvent(db, 'c2', 'p1');
    addEvent(db, 'w1', 'p2');
    const health = readSentinelHealthFromDb(db, PROJECT, { monitoring: true });
    expect(health!.criticalEvents).toBe(2);
    expect(health!.warningEvents).toBe(1);
  });

  it('未监控且从未有事件 ⇒ null（按 not-run 处理，不是满分）', () => {
    expect(readSentinelHealthFromDb(db, PROJECT, { monitoring: false })).toBeNull();
  });

  it('未监控但有历史事件 ⇒ 仍要出分（历史问题不会因为关掉监控而消失）', () => {
    addEvent(db, 'w1', 'p2');
    const health = readSentinelHealthFromDb(db, PROJECT, { monitoring: false });
    expect(health).not.toBeNull();
    expect(health!.active).toBe(false);
    expect(health!.warningEvents).toBe(1);
  });
});

describe('IPC 取数必须走 DB（调用边断言）', () => {
  it('getSentinelHealthData 先读 DB，listEvents 只作回退', () => {
    const src = readFileSync(new URL('../../electron/ipc/sentinel.ts', import.meta.url), 'utf-8');
    const start = src.indexOf('export async function getSentinelHealthData');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start);
    const dbCall = body.indexOf('readSentinelHealthFromDb');
    const memCall = body.indexOf('listEvents');
    expect(dbCall, '主路径必须是 DB 取数').toBeGreaterThanOrEqual(0);
    expect(memCall, '内存读取应仍作为回退存在').toBeGreaterThan(0);
    // 顺序即优先级：DB 在前、内存回退在后
    expect(dbCall).toBeLessThan(memCall);
    expect(body).toMatch(/getDb\(\)/);
  });
});
