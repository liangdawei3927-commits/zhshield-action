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

/**
 * 批量软删哨兵事件（打 `deleted_at`，不物理删）。
 *
 * 用途：收敛「规则收紧后已越界」的历史事件。忽略目录/应用包规则改了以后，
 * 库里那批旧事件本身已经失效（它们描述的是**不该被监控的路径**），
 * 但 `listSentinelEvents` 只过滤 `deleted_at IS NULL`，没人打标记就永远显示。
 * 2026-10-25 实测：修好 file-monitor 后新事件归零，页面上仍恒为 270 条。
 *
 * 返回实际被标记的行数（已软删的不会被重复计数）。
 */
export function softDeleteSentinelEvents(db: Database.Database, ids: readonly string[]): number {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return 0;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'UPDATE sentinel_events SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
  );
  const apply = db.transaction((list: readonly string[]): number => {
    let changed = 0;
    for (const id of list) changed += stmt.run(now, id).changes;
    return changed;
  });
  return apply(unique);
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
  // 软删事件不参与去重：用户删掉的那条不该在 10 分钟窗口里继续抑制同类新事件
  return db
    .prepare(
      `SELECT * FROM sentinel_events
       WHERE dedupe_key = ? AND deleted_at IS NULL
       ORDER BY last_seen DESC LIMIT 1`,
    )
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
 * 1. `listSentinelEvents` 默认 `LIMIT 100`，用于统计会被静默截断 —— 事件一多就少算；
 * 2. 评分只需要三个计数，`GROUP BY` 一次取回比拉全量行再在内存里数更可靠。
 *    （软删过滤两边现在都有；`listSentinelEvents` 原先缺 `deleted_at IS NULL`，
 *    2026-10-25 已补，否则默认 100 条会全是软删的历史噪音。）
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

  // 三档累加写成查表自增而不是 if / else-if 链：这里只有一个「是不是已知 severity」
  // 的判断，链式写法会把它叠成多层分支，且加第四档时还得再加一层。
  const counts: SentinelSeverityCounts = { p1: 0, p2: 0, p3: 0, total: 0 };
  for (const row of rows) {
    const n = Number(row.c) || 0;
    const severity = row.severity;
    if (severity === 'p1' || severity === 'p2' || severity === 'p3') counts[severity] += n;
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
  // 软删事件不对外：本项目实测表里 38144 行中有 37809 行是软删的，
  // 不带这个条件读取 = 默认 LIMIT 100 会全是已删除的历史噪音。
  let sql = ' AND deleted_at IS NULL';
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
