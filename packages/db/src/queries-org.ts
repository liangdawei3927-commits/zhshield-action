import type Database from 'better-sqlite3';
import type {
  OrgRow,
  OrgMemberRow,
  RuleScopeRow,
  ProjectFeatureRow,
  CreateOrgParams,
  AddOrgMemberParams,
  UpsertRuleScopeParams,
  SaveProjectFeaturesParams,
} from './types';

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
export function linkProjectToOrg(db: Database.Database, projectId: string, orgId: string): void {
  db.prepare('UPDATE projects SET org_id = ? WHERE id = ?').run(orgId, projectId);
}

export function getProjectOrgId(db: Database.Database, projectId: string): string | null {
  const row = db.prepare('SELECT org_id FROM projects WHERE id = ?').get(projectId) as
    { org_id: string | null } | undefined;
  return row?.org_id ?? null;
}

/**
 * 写入/更新规则租户快照（幂等 upsert）。
 * orgId = null 表示平台默认；组织行由 resolve 合并时覆盖平台行。
 * SQLite UNIQUE 视 NULL 互异，平台行（org_id NULL）用 UPDATE-then-INSERT 保证幂等。
 */
export function upsertRuleScope(db: Database.Database, params: UpsertRuleScopeParams): void {
  const isPlatform = params.orgId === null;
  const updated = db
    .prepare(
      `UPDATE rule_scope
       SET version = ?, enabled = ?, content_sha = ?, source = ?, published_at = CURRENT_TIMESTAMP
       WHERE rule_id = ? AND ${isPlatform ? 'org_id IS NULL' : 'org_id = ?'}`,
    )
    .run(
      params.version,
      params.enabled ? 1 : 0,
      params.contentSha,
      params.source ?? 'manual',
      params.ruleId,
      ...(isPlatform ? [] : [params.orgId]),
    );
  if (updated.changes === 0) {
    db.prepare(
      `INSERT INTO rule_scope (id, rule_id, org_id, version, enabled, content_sha, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
}

/**
 * 读取某租户的**生效**规则 scope：平台默认（org_id NULL）为底，
 * 组织行覆盖同 rule_id 的平台行。只在租户自己的行 + 平台行内取，绝无跨租户。
 */
export function getEffectiveRuleScope(db: Database.Database, orgId: string): RuleScopeRow[] {
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
  return db.prepare('SELECT * FROM project_features WHERE project_id = ?').get(projectId) as
    ProjectFeatureRow | undefined;
}

/** 删除某项目的画像快照行（T0 注销，与 saveProjectFeatures 对称） */
export function deleteProjectFeatures(db: Database.Database, projectId: string): void {
  db.prepare('DELETE FROM project_features WHERE project_id = ?').run(projectId);
}
