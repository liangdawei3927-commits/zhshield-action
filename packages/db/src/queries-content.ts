import type Database from 'better-sqlite3';
import type {
  RuleContentRow,
  RuleContentVersionRow,
  ToolPackageRow,
  ToolPackageVersionRow,
  ContentAuditLogRow,
  SaveRuleContentParams,
  SaveRuleContentVersionParams,
  SaveToolPackageParams,
  SaveToolPackageVersionParams,
  AppendAuditLogParams,
} from './types';

// ─── 规则内容仓库（迁移 010：rule_content / tool_package / *_version / content_audit_log）───

// ─── rule_content ───────────────────────────────────────────

export function listRuleContent(
  db: Database.Database,
  filter?: { domain?: string; status?: string },
): RuleContentRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter?.domain) {
    clauses.push('domain = ?');
    params.push(filter.domain);
  }
  if (filter?.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM rule_content ${where} ORDER BY domain, rule_id`;
  return (filter ? db.prepare(sql).all(...params) : db.prepare(sql).all()) as RuleContentRow[];
}

export function getRuleContent(db: Database.Database, ruleId: string): RuleContentRow | undefined {
  return db.prepare('SELECT * FROM rule_content WHERE rule_id = ?').get(ruleId) as
    RuleContentRow | undefined;
}

export function getRuleContentById(db: Database.Database, id: string): RuleContentRow | undefined {
  return db.prepare('SELECT * FROM rule_content WHERE id = ?').get(id) as
    RuleContentRow | undefined;
}

/** upsert 规则本体行（rule_id 冲突则整行更新 + bumped updated_at） */
export function saveRuleContent(db: Database.Database, params: SaveRuleContentParams): void {
  db.prepare(
    `INSERT INTO rule_content (
       id, rule_id, domain, action, source, name, description, severity, status,
       execution_mode, tags, applicable_engines, languages, frameworks,
       tool_id, tool_version, content, content_sha, version, created_by, updated_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(rule_id)
     DO UPDATE SET domain = excluded.domain,
                   action = excluded.action,
                   source = excluded.source,
                   name = excluded.name,
                   description = excluded.description,
                   severity = excluded.severity,
                   status = excluded.status,
                   execution_mode = excluded.execution_mode,
                   tags = excluded.tags,
                   applicable_engines = excluded.applicable_engines,
                   languages = excluded.languages,
                   frameworks = excluded.frameworks,
                   tool_id = excluded.tool_id,
                   tool_version = excluded.tool_version,
                   content = excluded.content,
                   content_sha = excluded.content_sha,
                   version = excluded.version,
                   updated_by = excluded.updated_by,
                   updated_at = CURRENT_TIMESTAMP`,
  ).run(
    params.id,
    params.ruleId,
    params.domain,
    params.action,
    params.source ?? 'official',
    params.name,
    params.description ?? null,
    params.severity,
    params.status ?? 'draft',
    params.executionMode ?? 'async',
    JSON.stringify(params.tags ?? []),
    JSON.stringify(params.applicableEngines ?? []),
    JSON.stringify(params.languages ?? []),
    JSON.stringify(params.frameworks ?? []),
    params.toolId ?? null,
    params.toolVersion ?? null,
    params.content,
    params.contentSha,
    params.version,
    params.createdBy ?? null,
    params.updatedBy ?? null,
  );
}

/** 软删（status → deprecated），保留行与历史 */
export function softDeleteRuleContent(db: Database.Database, ruleId: string): void {
  db.prepare(
    `UPDATE rule_content SET status = 'deprecated', updated_at = CURRENT_TIMESTAMP WHERE rule_id = ?`,
  ).run(ruleId);
}

/** 标记状态；状态机由服务层裁决 */
export function setRuleContentStatus(db: Database.Database, ruleId: string, status: string): void {
  db.prepare(
    `UPDATE rule_content SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE rule_id = ?`,
  ).run(status, ruleId);
}

// ─── rule_content_version ───────────────────────────────────

export function saveRuleContentVersion(
  db: Database.Database,
  params: SaveRuleContentVersionParams,
): void {
  db.prepare(
    `INSERT INTO rule_content_version (id, rule_id, version, content_sha, content, status_at_release, released_by, changes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.ruleId,
    params.version,
    params.contentSha,
    params.content,
    params.statusAtRelease,
    params.releasedBy ?? null,
    params.changes ?? null,
  );
}

export function listRuleContentVersions(
  db: Database.Database,
  ruleId: string,
): RuleContentVersionRow[] {
  return db
    .prepare(
      'SELECT * FROM rule_content_version WHERE rule_id = ? ORDER BY released_at DESC, version DESC',
    )
    .all(ruleId) as RuleContentVersionRow[];
}

export function getRuleContentVersion(
  db: Database.Database,
  ruleId: string,
  version: string,
): RuleContentVersionRow | undefined {
  return db
    .prepare('SELECT * FROM rule_content_version WHERE rule_id = ? AND version = ?')
    .get(ruleId, version) as RuleContentVersionRow | undefined;
}

// ─── tool_package ───────────────────────────────────────────

export function listToolPackages(db: Database.Database): ToolPackageRow[] {
  return db.prepare('SELECT * FROM tool_package ORDER BY tool_id').all() as ToolPackageRow[];
}

export function getToolPackage(db: Database.Database, toolId: string): ToolPackageRow | undefined {
  return db.prepare('SELECT * FROM tool_package WHERE tool_id = ?').get(toolId) as
    ToolPackageRow | undefined;
}

/** upsert 工具包当前行（tool_id 冲突则整行更新） */
export function saveToolPackage(db: Database.Database, params: SaveToolPackageParams): void {
  db.prepare(
    `INSERT INTO tool_package (
       id, tool_id, version, sha256, files_json, languages, frameworks,
       status, description, created_by, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(tool_id)
     DO UPDATE SET version = excluded.version,
                   sha256 = excluded.sha256,
                   files_json = excluded.files_json,
                   languages = excluded.languages,
                   frameworks = excluded.frameworks,
                   status = excluded.status,
                   description = excluded.description,
                   updated_at = CURRENT_TIMESTAMP`,
  ).run(
    params.id,
    params.toolId,
    params.version,
    params.sha256,
    params.filesJson,
    JSON.stringify(params.languages ?? []),
    JSON.stringify(params.frameworks ?? []),
    params.status ?? 'active',
    params.description ?? null,
    params.createdBy ?? null,
  );
}

/** 软删（status → disabled），保留行与历史 */
export function softDeleteToolPackage(db: Database.Database, toolId: string): void {
  db.prepare(
    `UPDATE tool_package SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE tool_id = ?`,
  ).run(toolId);
}

// ─── tool_package_version ───────────────────────────────────

export function saveToolPackageVersion(
  db: Database.Database,
  params: SaveToolPackageVersionParams,
): void {
  db.prepare(
    `INSERT INTO tool_package_version (id, tool_id, version, sha256, files_json, languages, frameworks, released_by, changes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.toolId,
    params.version,
    params.sha256,
    params.filesJson,
    JSON.stringify(params.languages ?? []),
    JSON.stringify(params.frameworks ?? []),
    params.releasedBy ?? null,
    params.changes ?? null,
  );
}

export function listToolPackageVersions(
  db: Database.Database,
  toolId: string,
): ToolPackageVersionRow[] {
  return db
    .prepare(
      'SELECT * FROM tool_package_version WHERE tool_id = ? ORDER BY released_at DESC, version DESC',
    )
    .all(toolId) as ToolPackageVersionRow[];
}

// ─── content_audit_log ──────────────────────────────────────

export function appendAuditLog(db: Database.Database, params: AppendAuditLogParams): void {
  db.prepare(
    `INSERT INTO content_audit_log (id, entity_type, entity_id, action, detail, operator)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.entityType,
    params.entityId,
    params.action,
    params.detail ?? null,
    params.operator,
  );
}

export function listAuditLogs(
  db: Database.Database,
  filter?: { entityType?: 'rule' | 'tool'; entityId?: string; limit?: number },
): ContentAuditLogRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter?.entityType) {
    clauses.push('entity_type = ?');
    params.push(filter.entityType);
  }
  if (filter?.entityId) {
    clauses.push('entity_id = ?');
    params.push(filter.entityId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filter?.limit ?? 100;
  const sql = `SELECT * FROM content_audit_log ${where} ORDER BY operated_at DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit) as ContentAuditLogRow[];
}
