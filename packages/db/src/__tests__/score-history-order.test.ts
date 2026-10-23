import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getLatestScore, getScoreHistory } from '../queries-projects';

/**
 * 评分历史排序契约回归（P0，2026-10-24）。
 *
 * 事故形态：`getScoreHistory` 用 `ORDER BY created_at DESC LIMIT ?` 直接返回倒序数组，
 * 而所有消费方都按「旧 → 新」读取：
 * - 报告中心 `data.at(-1)` 当「最新总分」→ 实际拿到项目史上第一条记录；
 * - `HistoryTable` 再 `toReversed()` → 表格变最旧在上；
 * - `getTrendReport` 取 `slice(-windowSize)` → 近期窗口变成远古窗口。
 *
 * 症状不是「顺序不对」而是「内容取反」：报告中心的维度卡片数量会随那条老记录的
 * 维度集变化（5 张 / 7 张 / 10 张），用户看到「有时 5 张有时 10 张」。
 *
 * 单测此前全绿是因为服务端单测跑的是**内存引擎**（push 顺序天然升序），
 * 生产路径 `new ScoringEngine(db)` 才走 SQL —— 典型「测试绿、生产错」。
 */

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'));
  }
  return db;
}

/** 直插一条评分，created_at 由用例显式指定（saveScore 走 CURRENT_TIMESTAMP，秒级不可控） */
function insertScore(
  db: Database.Database,
  params: { projectId: string; overall: number; createdAt: string; deletedAt?: string | null },
): void {
  db.prepare(
    `INSERT INTO scores (project_id, overall, grade, dimensions, trend, created_at, deleted_at)
     VALUES (?, ?, 'B', ?, 'stable', ?, ?)`,
  ).run(
    params.projectId,
    params.overall,
    JSON.stringify([{ name: 'quality', weight: 0.1, score: params.overall, issues: 0 }]),
    params.createdAt,
    params.deletedAt ?? null,
  );
}

describe('评分历史排序契约', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('按时间升序返回：数组末尾 = 最新一条（渲染层 at(-1) 依赖此契约）', () => {
    insertScore(db, { projectId: 'p', overall: 70, createdAt: '2026-08-01 10:00:00' });
    insertScore(db, { projectId: 'p', overall: 80, createdAt: '2026-09-01 10:00:00' });
    insertScore(db, { projectId: 'p', overall: 90, createdAt: '2026-10-01 10:00:00' });

    const history = getScoreHistory(db, 'p');
    expect(history.map((r) => r.overall)).toEqual([70, 80, 90]);
    expect(history.at(-1)!.overall).toBe(90);
  });

  it('limit 截断取「最新 N 条」，不是最旧 N 条', () => {
    for (let i = 0; i < 5; i++) {
      insertScore(db, {
        projectId: 'p',
        overall: 60 + i * 5,
        createdAt: `2026-10-0${i + 1} 10:00:00`,
      });
    }
    const history = getScoreHistory(db, 'p', 3);
    expect(history.map((r) => r.overall)).toEqual([70, 75, 80]);
    expect(history.at(-1)!.overall).toBe(80); // 最新一条必须是 80
  });

  it('同一秒内并列落分：以 id 决定先后，最新一条稳定为后插入的', () => {
    insertScore(db, { projectId: 'p', overall: 66, createdAt: '2026-10-10 10:00:00' });
    insertScore(db, { projectId: 'p', overall: 88, createdAt: '2026-10-10 10:00:00' });
    insertScore(db, { projectId: 'p', overall: 77, createdAt: '2026-10-10 10:00:00' });

    const history = getScoreHistory(db, 'p');
    expect(history.map((r) => r.overall)).toEqual([66, 88, 77]);
    expect(getLatestScore(db, 'p')!.overall).toBe(77);
  });

  it('软删记录不出现在历史里（项目移除后其旧分不得再参与展示）', () => {
    insertScore(db, { projectId: 'p', overall: 70, createdAt: '2026-10-01 10:00:00' });
    insertScore(db, {
      projectId: 'p',
      overall: 50,
      createdAt: '2026-10-02 10:00:00',
      deletedAt: '2026-10-03 10:00:00',
    });
    insertScore(db, { projectId: 'p', overall: 90, createdAt: '2026-10-04 10:00:00' });

    expect(getScoreHistory(db, 'p').map((r) => r.overall)).toEqual([70, 90]);
  });

  it('最新一条若被软删，latest 回退到仍有效的上一条', () => {
    insertScore(db, { projectId: 'p', overall: 70, createdAt: '2026-10-01 10:00:00' });
    insertScore(db, {
      projectId: 'p',
      overall: 99,
      createdAt: '2026-10-05 10:00:00',
      deletedAt: '2026-10-06 10:00:00',
    });

    expect(getLatestScore(db, 'p')!.overall).toBe(70);
  });

  it('不同项目互不干扰', () => {
    insertScore(db, { projectId: 'a', overall: 10, createdAt: '2026-10-01 10:00:00' });
    insertScore(db, { projectId: 'b', overall: 20, createdAt: '2026-10-02 10:00:00' });

    expect(getScoreHistory(db, 'a').map((r) => r.overall)).toEqual([10]);
    expect(getScoreHistory(db, 'b').map((r) => r.overall)).toEqual([20]);
  });
});
