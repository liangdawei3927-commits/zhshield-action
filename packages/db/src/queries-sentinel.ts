import type Database from 'better-sqlite3';
import type {
  CreateSentinelEventParams,
  UpdateSentinelEventParams,
  ListSentinelEventsFilter,
  SentinelEventRow,
} from './types';

// ─── Sentinel Events ───────────────────────────────────────

export function createSentinelEvent(
  db: Database.Database,
  params: CreateSentinelEventParams,
): void {
  db.prepare(
    `
    INSERT INTO sentinel_events (id, project_id, timestamp, dedupe_key, title, service, module, severity, status, validation, context, history, occurrence_count, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    params.id,
    params.projectId,
    params.timestamp.toISOString(),
    params.dedupeKey,
    params.title,
    params.service,
    params.module,
    params.severity,
    params.status,
    params.validation,
    params.context,
    params.history,
    params.occurrenceCount,
    params.firstSeen.toISOString(),
    params.lastSeen.toISOString(),
  );
}

export function updateSentinelEvent(
  db: Database.Database,
  params: UpdateSentinelEventParams,
): void {
  const { sets, values } = collectUpdateSets(params);
  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  values.push(params.id);

  db.prepare(`UPDATE sentinel_events SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/** 收集需要更新的字段与对应值 */
function collectUpdateSets(params: UpdateSentinelEventParams): {
  sets: string[];
  values: unknown[];
} {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (params.status !== undefined) {
    sets.push('status = ?');
    values.push(params.status);
  }
  if (params.validation !== undefined) {
    sets.push('validation = ?');
    values.push(params.validation);
  }
  if (params.history !== undefined) {
    sets.push('history = ?');
    values.push(params.history);
  }
  if (params.occurrenceCount !== undefined) {
    sets.push('occurrence_count = ?');
    values.push(params.occurrenceCount);
  }
  if (params.lastSeen !== undefined) {
    sets.push('last_seen = ?');
    values.push(params.lastSeen.toISOString());
  }

  return { sets, values };
}

export function getSentinelEvent(db: Database.Database, id: string): SentinelEventRow | undefined {
  return db.prepare('SELECT * FROM sentinel_events WHERE id = ?').get(id) as
    SentinelEventRow | undefined;
}

export function findSentinelEventByDedupeKey(
  db: Database.Database,
  dedupeKey: string,
): SentinelEventRow | undefined {
  return db
    .prepare('SELECT * FROM sentinel_events WHERE dedupe_key = ? ORDER BY last_seen DESC LIMIT 1')
    .get(dedupeKey) as SentinelEventRow | undefined;
}

export function listSentinelEvents(
  db: Database.Database,
  filter?: ListSentinelEventsFilter,
): SentinelEventRow[] {
  const { sql, params } = buildSentinelQuery(filter);
  return db.prepare(sql).all(...params) as SentinelEventRow[];
}

/**
 * 按 severity 统计某项目**未软删**的哨兵事件数（供评分取数）。
 *
 * 为什么单列一个计数函数，而不是复用 `listSentinelEvents`：
 * 1. `listSentinelEvents` **不带 `deleted_at IS NULL`**（会把软删事件算进来）；
 * 2. 它默认 `LIMIT 100`，用于统计会被静默截断 —— 事件一多就少算；
 * 3. 评分只需要三个计数，`GROUP BY` 一次取回比拉全量行再在内存里数更可靠。
 *
 * 曾经评分侧直接读 `EventCenter.listEvents()`（**内存 Map**），库里落盘的事件一条
 * 也读不到 ⇒ 哨兵域恒 100 分。计数必须落回 DB，这是该缺陷的修复落点。
 */
export interface SentinelSeverityCounts {
  p1: number;
  p2: number;
  p3: number;
  /** 未软删且未被排除的事件总数 */
  total: number;
}

export function countSentinelEventsBySeverity(
  db: Database.Database,
  projectId: string,
  options?: { excludeStatuses?: readonly string[] },
): SentinelSeverityCounts {
  const params: unknown[] = [projectId];
  let statusClause = '';
  const excluded = (options?.excludeStatuses ?? []).filter((s) => typeof s === 'string');
  if (excluded.length > 0) {
    statusClause = ` AND status NOT IN (${excluded.map(() => '?').join(', ')})`;
    params.push(...excluded);
  }
  const rows = db
    .prepare(
      `SELECT severity, COUNT(*) AS c FROM sentinel_events
       WHERE deleted_at IS NULL AND project_id = ?${statusClause}
       GROUP BY severity`,
    )
    .all(...params) as Array<{ severity: string; c: number }>;

  const counts: SentinelSeverityCounts = { p1: 0, p2: 0, p3: 0, total: 0 };
  for (const row of rows) {
    const n = Number(row.c) || 0;
    if (row.severity === 'p1') counts.p1 += n;
    else if (row.severity === 'p2') counts.p2 += n;
    else if (row.severity === 'p3') counts.p3 += n;
    counts.total += n;
  }
  return counts;
}

/** 构建 sentinel_events 查询 SQL 与参数 */
function buildSentinelQuery(filter?: ListSentinelEventsFilter): { sql: string; params: unknown[] } {
  const where = buildSentinelWhere(filter);
  const pagination = buildSentinelPagination(filter);
  return {
    sql: `SELECT * FROM sentinel_events WHERE 1=1${where.sql} ORDER BY timestamp DESC${pagination.sql}`,
    params: [...where.params, ...pagination.params],
  };
}

/** 构建 WHERE 过滤条件 */
function buildSentinelWhere(filter?: ListSentinelEventsFilter): { sql: string; params: unknown[] } {
  let sql = '';
  const params: unknown[] = [];
  if (filter?.projectId) {
    sql += ' AND project_id = ?';
    params.push(filter.projectId);
  }
  if (filter?.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  if (filter?.severity) {
    sql += ' AND severity = ?';
    params.push(filter.severity);
  }
  return { sql, params };
}

/** 构建 LIMIT/OFFSET 分页子句 */
function buildSentinelPagination(filter?: ListSentinelEventsFilter): {
  sql: string;
  params: unknown[];
} {
  let sql = '';
  const params: unknown[] = [];
  if (filter?.limit) sql += ' LIMIT ?';
  else sql += ' LIMIT 100';
  if (filter?.limit) params.push(filter.limit);
  if (filter?.offset) {
    sql += ' OFFSET ?';
    params.push(filter.offset);
  }
  return { sql, params };
}

export function deleteSentinelEvent(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM sentinel_events WHERE id = ?').run(id);
}

export function getSentinelEventStats(db: Database.Database): Record<string, number> {
  const total = (db.prepare('SELECT COUNT(*) as c FROM sentinel_events').get() as { c: number }).c;
  const bySeverity = db
    .prepare('SELECT severity, COUNT(*) as c FROM sentinel_events GROUP BY severity')
    .all() as Array<{ severity: string; c: number }>;
  const byStatus = db
    .prepare('SELECT status, COUNT(*) as c FROM sentinel_events GROUP BY status')
    .all() as Array<{ status: string; c: number }>;
  const stats: Record<string, number> = { total };
  for (const row of bySeverity) stats[`severity_${row.severity}`] = row.c;
  for (const row of byStatus) stats[`status_${row.status}`] = row.c;
  return stats;
}
