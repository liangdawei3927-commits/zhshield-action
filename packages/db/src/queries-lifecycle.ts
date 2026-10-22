import type Database from 'better-sqlite3';
import { getProjectByPath } from './queries-projects';

// ─── 项目数据清理(R1:删项目完整归还,软删标记)───

/** 随项目删除而软删的数据表（不含 experiences，见下） */
const PROJECT_DATA_TABLES = [
  'scores',
  'scanning_results',
  'debt_actions',
  'debt_snapshots',
  'sentinel_events',
] as const;

/**
 * 对某项目的关联数据打软删标记（deleted_at = now）。
 * 先 getProjectByPath 反查；desktop 从不写 projects 表（见 008 注释），
 * 无行则直接按 project_id = projectPath 清理（与桌面写入键控对齐）；
 * 有行 → 对该 project.id，按固定表顺序
 * 对 5 张表执行 UPDATE <表> SET deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL。
 * 注意：experiences 是全局校准样本库，不随项目删除（06 §2.4），不在此列。
 */
export function softDeleteProjectData(db: Database.Database, projectPath: string): void {
  // 桌面路径:从不写 projects 表(008),写入键控 project_id = projectPath → 直接按 path 清理
  // 服务端路径:有 projects 行,按 id 清理(行为不变)
  const project = getProjectByPath(db, projectPath);
  const key = project ? project.id : projectPath;
  const now = new Date().toISOString();
  // 提取 prepared statement 循环外复用（perf-batch-db-write：循环内 prepare 属单行写入低效模式）
  const stmts = PROJECT_DATA_TABLES.map((table) =>
    db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL`),
  );
  for (const stmt of stmts) {
    stmt.run(now, key);
  }
}

// ─── 孤儿治理查询 (Orphan Governance) ─────────────────────

/**
 * 在固定 5 表上按 deleted_at 条件收集 project_id（UNION 去重）。
 * 抽取自 listActiveProjectIds / listSoftDeletedProjectIds 的重复块：
 * 两查询仅 WHERE 条件（deleted_at IS NULL vs IS NOT NULL）不同，其余结构一致。
 */
function collectProjectIdsByDeletedFlag(db: Database.Database, deletedWhere: string): string[] {
  const unionSql = PROJECT_DATA_TABLES.map(
    (t) => `SELECT DISTINCT project_id FROM ${t} WHERE ${deletedWhere}`,
  ).join(' UNION ');
  const rows = db.prepare(unionSql).all() as { project_id: string }[];
  return rows.map((r) => r.project_id);
}

/**
 * 列出所有仍有活跃（未软删）关联数据的 project_id。
 * 对 PROJECT_DATA_TABLES 5 表各 SELECT DISTINCT project_id WHERE deleted_at IS NULL，
 * UNION 去重后返回。
 */
export function listActiveProjectIds(db: Database.Database): string[] {
  return collectProjectIdsByDeletedFlag(db, 'deleted_at IS NULL');
}

/**
 * 列出所有仅有软删（deleted_at IS NOT NULL）关联数据、且无活跃数据的 project_id。
 * 对 PROJECT_DATA_TABLES 5 表各 SELECT DISTINCT project_id WHERE deleted_at IS NOT NULL，
 * UNION 去重后返回。
 */
export function listSoftDeletedProjectIds(db: Database.Database): string[] {
  return collectProjectIdsByDeletedFlag(db, 'deleted_at IS NOT NULL');
}

/**
 * 物理删除已过 TTL 的软删行。
 * 对 5 表执行 DELETE … WHERE deleted_at IS NOT NULL AND julianday(deleted_at) < julianday('now', '-N days')
 * 用 julianday 做跨格式比较（ISO 8601 字符串 vs SQLite datetime 格式）。
 * 在 db.transaction 内执行保证原子性。
 */
export function purgeExpiredSoftDeleted(
  db: Database.Database,
  ttlDays: number,
): { table: string; deleted: number }[] {
  const results: { table: string; deleted: number }[] = [];
  const statements = PROJECT_DATA_TABLES.map((table) =>
    db.prepare(
      `DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND julianday(deleted_at) < julianday('now', '-${ttlDays} days')`,
    ),
  );
  db.transaction(() => {
    for (let i = 0; i < PROJECT_DATA_TABLES.length; i++) {
      const info = statements[i].run();
      results.push({ table: PROJECT_DATA_TABLES[i], deleted: info.changes });
    }
  })();
  return results;
}

/**
 * 统计某项目在各表中的活跃（未软删）行数。
 * 只返回 count > 0 的表。
 */
export function countActiveRows(
  db: Database.Database,
  projectId: string,
): { table: string; count: number }[] {
  const results: { table: string; count: number }[] = [];
  const statements = PROJECT_DATA_TABLES.map((table) =>
    db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE project_id = ? AND deleted_at IS NULL`),
  );
  for (let i = 0; i < PROJECT_DATA_TABLES.length; i++) {
    const row = statements[i].get(projectId) as { cnt: number };
    if (row.cnt > 0) {
      results.push({ table: PROJECT_DATA_TABLES[i], count: row.cnt });
    }
  }
  return results;
}
