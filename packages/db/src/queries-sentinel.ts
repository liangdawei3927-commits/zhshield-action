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
