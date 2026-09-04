import type Database from 'better-sqlite3';
import type {
  ProjectRow,
  ScoreRow,
  ScanningResultRow,
  RuleRow,
  ExperienceRow,
  CreateProjectParams,
  SaveScoreParams,
  SaveScanResultParams,
  UpsertRuleParams,
  SaveExperienceParams,
  SaveDebtActionParams,
  UpdateDebtActionStatusParams,
  DebtActionRow,
  SaveDebtSnapshotParams,
  DebtSnapshotRow,
  CreateSentinelEventParams,
  UpdateSentinelEventParams,
  ListSentinelEventsFilter,
  SentinelEventRow,
  OrgRow,
  OrgMemberRow,
  RuleScopeRow,
  ProjectFeatureRow,
  CreateOrgParams,
  AddOrgMemberParams,
  UpsertRuleScopeParams,
  SaveProjectFeaturesParams,
} from './types';

// ─── Projects ─────────────────────────────────────────────

export function createProject(db: Database.Database, params: CreateProjectParams): void {
  db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(
    params.id,
    params.name,
    params.path,
  );
}

export function getProject(db: Database.Database, id: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}

export function getProjectByPath(db: Database.Database, path: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as ProjectRow | undefined;
}

export function listProjects(db: Database.Database): ProjectRow[] {
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
}

export function deleteProject(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ─── Scores ───────────────────────────────────────────────

export function saveScore(db: Database.Database, params: SaveScoreParams): void {
  db.prepare(
    'INSERT INTO scores (project_id, overall, grade, dimensions, trend) VALUES (?, ?, ?, ?, ?)',
  ).run(params.projectId, params.overall, params.grade, params.dimensions, params.trend);
}

export function getLatestScore(db: Database.Database, projectId: string): ScoreRow | undefined {
  return db
    .prepare('SELECT * FROM scores WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(projectId) as ScoreRow | undefined;
}

export function getScoreHistory(db: Database.Database, projectId: string, limit = 30): ScoreRow[] {
  return db
    .prepare('SELECT * FROM scores WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(projectId, limit) as ScoreRow[];
}

export function getScoreTrend(db: Database.Database, projectId: string): ScoreRow[] {
  return db
    .prepare('SELECT * FROM scores WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as ScoreRow[];
}

// ─── Scanning Results ─────────────────────────────────────

export function saveScanResult(db: Database.Database, params: SaveScanResultParams): void {
  db.prepare(
    'INSERT INTO scanning_results (project_id, source, passed, summary, report) VALUES (?, ?, ?, ?, ?)',
  ).run(
    params.projectId,
    params.source,
    params.passed ? 1 : 0,
    params.summary,
    params.report ?? null,
  );
}

export function getLatestScanResult(
  db: Database.Database,
  projectId: string,
  source: string,
): ScanningResultRow | undefined {
  return db
    .prepare(
      'SELECT * FROM scanning_results WHERE project_id = ? AND source = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(projectId, source) as ScanningResultRow | undefined;
}

export function listScanResults(
  db: Database.Database,
  projectId: string,
  source?: string,
): ScanningResultRow[] {
  if (source) {
    return db
      .prepare(
        'SELECT * FROM scanning_results WHERE project_id = ? AND source = ? ORDER BY created_at DESC',
      )
      .all(projectId, source) as ScanningResultRow[];
  }
  return db
    .prepare('SELECT * FROM scanning_results WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as ScanningResultRow[];
}

// ─── Rules ────────────────────────────────────────────────

export function upsertRule(db: Database.Database, params: UpsertRuleParams): void {
  db.prepare(
    `
    INSERT INTO rules (id, rule_id, state, severity, weight, reason, changed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rule_id) DO UPDATE SET
      state      = COALESCE(?, state),
      severity   = COALESCE(?, severity),
      weight     = COALESCE(?, weight),
      reason     = COALESCE(?, reason),
      changed_by = COALESCE(?, changed_by),
      changed_at = CURRENT_TIMESTAMP
  `,
  ).run(
    params.ruleId,
    params.ruleId,
    params.state ?? 'active',
    params.severity ?? null,
    params.weight ?? 1.0,
    params.reason ?? null,
    params.changedBy ?? null,
    // COALESCE args
    params.state ?? null,
    params.severity ?? null,
    params.weight ?? null,
    params.reason ?? null,
    params.changedBy ?? null,
  );
}

export function getRule(db: Database.Database, ruleId: string): RuleRow | undefined {
  return db.prepare('SELECT * FROM rules WHERE rule_id = ?').get(ruleId) as RuleRow | undefined;
}

export function listRules(db: Database.Database): RuleRow[] {
  return db.prepare('SELECT * FROM rules ORDER BY changed_at DESC').all() as RuleRow[];
}

// ─── Experiences ──────────────────────────────────────────

export function saveExperience(db: Database.Database, params: SaveExperienceParams): void {
  db.prepare(
    'INSERT INTO experiences (id, project_id, rule_id, type, detail, source) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    params.id,
    params.projectId,
    params.ruleId,
    params.type,
    params.detail ?? null,
    params.source ?? null,
  );
}

export function listExperiences(
  db: Database.Database,
  projectId?: string,
  ruleId?: string,
): ExperienceRow[] {
  let sql = 'SELECT * FROM experiences WHERE 1=1';
  const params: unknown[] = [];
  if (projectId) {
    sql += ' AND project_id = ?';
    params.push(projectId);
  }
  if (ruleId) {
    sql += ' AND rule_id = ?';
    params.push(ruleId);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params) as ExperienceRow[];
}

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

export function getExperienceStats(
  db: Database.Database,
  ruleId: string,
): { total: number; truePositives: number; falsePositives: number } {
  const total = (
    db.prepare('SELECT COUNT(*) as c FROM experiences WHERE rule_id = ?').get(ruleId) as {
      c: number;
    }
  ).c;
  const truePositives = (
    db
      .prepare("SELECT COUNT(*) as c FROM experiences WHERE rule_id = ? AND type = 'true-positive'")
      .get(ruleId) as { c: number }
  ).c;
  const falsePositives = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM experiences WHERE rule_id = ? AND type = 'false-positive'",
      )
      .get(ruleId) as { c: number }
  ).c;
  return { total, truePositives, falsePositives };
}

// ─── Tech Debt Actions & Snapshots ────────────────────────

export function saveDebtAction(db: Database.Database, params: SaveDebtActionParams): void {
  db.prepare(
    `INSERT INTO debt_actions (project_id, action_id, status, module, category, issue_ids, interest_score, principal_estimate, roi, sprint, gate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, action_id) DO UPDATE SET
       status = excluded.status,
       module = excluded.module,
       category = excluded.category,
       issue_ids = excluded.issue_ids,
       interest_score = excluded.interest_score,
       principal_estimate = excluded.principal_estimate,
       roi = excluded.roi,
       sprint = excluded.sprint,
       gate = excluded.gate,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    params.projectId,
    params.actionId,
    params.status,
    params.module,
    params.category,
    JSON.stringify(params.issueIds),
    params.interestScore,
    params.principalEstimate,
    params.roi,
    params.sprint ?? null,
    params.gate ?? null,
  );
}

export function updateDebtActionStatus(
  db: Database.Database,
  params: UpdateDebtActionStatusParams,
): void {
  db.prepare(
    'UPDATE debt_actions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE project_id = ? AND action_id = ?',
  ).run(params.status, params.projectId, params.actionId);
}

export function getDebtActionsByProject(db: Database.Database, projectId: string): DebtActionRow[] {
  return db
    .prepare('SELECT * FROM debt_actions WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as DebtActionRow[];
}

export function saveDebtSnapshot(db: Database.Database, params: SaveDebtSnapshotParams): void {
  db.prepare('INSERT INTO debt_snapshots (project_id, debt_index) VALUES (?, ?)').run(
    params.projectId,
    params.debtIndex,
  );
}

export function getLatestDebtSnapshot(
  db: Database.Database,
  projectId: string,
): DebtSnapshotRow | undefined {
  return db
    .prepare('SELECT * FROM debt_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT 1')
    .get(projectId) as DebtSnapshotRow | undefined;
}

// ─── M3 轻量 Org 多租户 ───────────────────────────────────
// 租户隔离纪律：全部读取显式带 org_id 过滤；跨租户不可见由单测断言。

export function createOrg(db: Database.Database, params: CreateOrgParams): void {
  db.prepare('INSERT INTO orgs (id, name, owner_user_id) VALUES (?, ?, ?)').run(
    params.id,
    params.name,
    params.ownerUserId,
  );
}

export function getOrg(db: Database.Database, id: string): OrgRow | undefined {
  return db.prepare('SELECT * FROM orgs WHERE id = ?').get(id) as OrgRow | undefined;
}

export function addOrgMember(db: Database.Database, params: AddOrgMemberParams): void {
  db.prepare('INSERT INTO org_members (id, org_id, user_id, role) VALUES (?, ?, ?, ?)').run(
    params.id,
    params.orgId,
    params.userId,
    params.role,
  );
}

export function getOrgMember(
  db: Database.Database,
  orgId: string,
  userId: string,
): OrgMemberRow | undefined {
  return db
    .prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId) as OrgMemberRow | undefined;
}

export function listOrgsForUser(db: Database.Database, userId: string): OrgRow[] {
  return db
    .prepare(
      'SELECT o.* FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at DESC',
    )
    .all(userId) as OrgRow[];
}

/** 将既有项目挂到组织（组织内共享项目） */
export function linkProjectToOrg(
  db: Database.Database,
  projectId: string,
  orgId: string,
): void {
  db.prepare('UPDATE projects SET org_id = ? WHERE id = ?').run(orgId, projectId);
}

export function getProjectOrgId(db: Database.Database, projectId: string): string | null {
  const row = db.prepare('SELECT org_id FROM projects WHERE id = ?').get(projectId) as
    | { org_id: string | null }
    | undefined;
  return row?.org_id ?? null;
}

/**
 * 写入/更新规则租户快照（幂等 upsert）。
 * orgId = null 表示平台默认；组织行由 resolve 合并时覆盖平台行。
 */
export function upsertRuleScope(db: Database.Database, params: UpsertRuleScopeParams): void {
  db.prepare(
    `INSERT INTO rule_scope (id, rule_id, org_id, version, enabled, content_sha, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, rule_id)
     DO UPDATE SET version = excluded.version,
                   enabled = excluded.enabled,
                   content_sha = excluded.content_sha,
                   source = excluded.source,
                   published_at = CURRENT_TIMESTAMP`,
  ).run(
    params.id,
    params.ruleId,
    params.orgId,
    params.version,
    params.enabled ? 1 : 0,
    params.contentSha,
    params.source ?? 'manual',
  );
}

/**
 * 读取某租户的**生效**规则 scope：平台默认（org_id NULL）为底，
 * 组织行覆盖同 rule_id 的平台行。只在租户自己的行 + 平台行内取，绝无跨租户。
 */
export function getEffectiveRuleScope(
  db: Database.Database,
  orgId: string,
): RuleScopeRow[] {
  const rows = db
    .prepare('SELECT * FROM rule_scope WHERE org_id IS NULL OR org_id = ? ORDER BY rule_id')
    .all(orgId) as RuleScopeRow[];
  const byRule = new Map<string, RuleScopeRow>();
  for (const row of rows) {
    // 排序保证平台行（NULL）先到、组织行后到覆盖；再保险用显式判空
    const prev = byRule.get(row.rule_id);
    if (!prev || (prev.org_id === null && row.org_id !== null)) {
      byRule.set(row.rule_id, row);
    }
  }
  return [...byRule.values()];
}

export function saveProjectFeatures(
  db: Database.Database,
  params: SaveProjectFeaturesParams,
): void {
  db.prepare(
    `INSERT INTO project_features (id, project_id, framework, language, features_json, schema_version)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id)
     DO UPDATE SET framework = excluded.framework,
                   language = excluded.language,
                   features_json = excluded.features_json,
                   schema_version = excluded.schema_version,
                   updated_at = CURRENT_TIMESTAMP`,
  ).run(
    params.id,
    params.projectId,
    params.framework ?? null,
    params.language ?? null,
    JSON.stringify(params.features),
    params.schemaVersion ?? 1,
  );
}

export function getProjectFeatures(
  db: Database.Database,
  projectId: string,
): ProjectFeatureRow | undefined {
  return db
    .prepare('SELECT * FROM project_features WHERE project_id = ?')
    .get(projectId) as ProjectFeatureRow | undefined;
}
