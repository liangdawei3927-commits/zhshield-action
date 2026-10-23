import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 013 迁移：模块评分的 project_id 从相对路径回填为绝对路径。
 *
 * 这是**数据变换**而非建表迁移，写错只会在真实库上暴露一次，因此单独锁行为。
 * 归属判据必须是确定性的：同秒存在**唯一**一个项目级（绝对路径）记录才回填，
 * 找不到或多个候选一律不归属 —— 猜错的归属比缺失更糟（会把一个项目的历史挂到别人名下）。
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const SCORES_SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, '002_scores.sql'), 'utf-8');
const MIGRATION_013 = fs.readFileSync(
  path.join(MIGRATIONS_DIR, '013_module_score_abs_id.sql'),
  'utf-8',
);

let db: Database.Database;

function insertScore(projectId: string, createdAt: string, overall = 90): void {
  db.prepare(
    `INSERT INTO scores (project_id, overall, grade, dimensions, trend, created_at)
     VALUES (?, ?, 'A', '[]', 'stable', ?)`,
  ).run(projectId, overall, createdAt);
}

function ids(): string[] {
  return (
    db.prepare('SELECT project_id FROM scores ORDER BY id').all() as { project_id: string }[]
  ).map((r) => r.project_id);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCORES_SQL);
});

afterEach(() => {
  db.close();
});

describe('013_module_score_abs_id — 相对路径回填为绝对路径', () => {
  it('同秒存在唯一项目级记录时，按该项目根回填', () => {
    insertScore('/proj/a', '2026-10-20 15:14:31');
    insertScore('packages/ui', '2026-10-20 15:14:31', 95);
    insertScore('packages/api-sdk', '2026-10-20 15:14:31', 99);

    db.exec(MIGRATION_013);

    expect(ids()).toEqual(['/proj/a', '/proj/a/packages/ui', '/proj/a/packages/api-sdk']);
  });

  it('同秒存在多个不同项目候选时保持原样（歧义不猜）', () => {
    insertScore('/proj/a', '2026-10-20 15:14:31');
    insertScore('/proj/b', '2026-10-20 15:14:31');
    insertScore('packages/ui', '2026-10-20 15:14:31');

    db.exec(MIGRATION_013);

    expect(ids()).toContain('packages/ui');
  });

  it('找不到同秒项目级记录时保持原样（孤儿不归属）', () => {
    insertScore('/proj/a', '2026-10-20 15:14:31');
    insertScore('packages/ui', '2026-10-21 09:00:00');

    db.exec(MIGRATION_013);

    expect(ids()).toContain('packages/ui');
  });

  it('已是绝对路径的记录不受影响', () => {
    insertScore('/proj/a', '2026-10-20 15:14:31');
    insertScore('/proj/a/packages/web', '2026-10-20 15:14:31', 80);

    db.exec(MIGRATION_013);

    expect(ids()).toEqual(['/proj/a', '/proj/a/packages/web']);
  });

  it('多个子模块与唯一项目同秒时全部回填，总行数不变', () => {
    insertScore('/proj/a', '2026-10-20 15:14:31');
    for (const m of ['packages/cli', 'packages/db', 'packages/kernel']) {
      insertScore(m, '2026-10-20 15:14:31', 90);
    }
    const before = ids().length;

    db.exec(MIGRATION_013);

    const after = ids();
    expect(after).toHaveLength(before);
    expect(after.filter((p) => p.startsWith('/proj/a/'))).toHaveLength(3);
    expect(after.filter((p) => !p.startsWith('/'))).toHaveLength(0);
  });

  it('重复执行幂等（已回填的不再变动）', () => {
    insertScore('/proj/a', '2026-10-20 15:14:31');
    insertScore('packages/ui', '2026-10-20 15:14:31');

    db.exec(MIGRATION_013);
    const once = ids();
    db.exec(MIGRATION_013);

    expect(ids()).toEqual(once);
  });
});
