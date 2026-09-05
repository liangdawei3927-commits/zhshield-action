import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {
  createProject,
  createOrg,
  addOrgMember,
  getOrgMember,
  listOrgsForUser,
  linkProjectToOrg,
  getProjectOrgId,
  upsertRuleScope,
  getEffectiveRuleScope,
  saveProjectFeatures,
  getProjectFeatures,
} from '../queries';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
  }
  return db;
}

describe('M3 轻量 Org 多租户（迁移 009）', () => {
  it('GIVEN 迁移 009 WHEN 建库 THEN 租户五件套表全部存在', () => {
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('orgs');
    expect(names).toContain('org_members');
    expect(names).toContain('rule_scope');
    expect(names).toContain('project_features');
    // projects 表获得 org_id 列
    const cols = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('org_id');
  });

  it('GIVEN 两个 Org 各自 rule_scope WHEN 读生效 scope THEN 跨租户互相不可见（验收 1）', () => {
    const db = createTestDb();
    createOrg(db, { id: 'org_a', name: 'A 组织', ownerUserId: 'user_a' });
    createOrg(db, { id: 'org_b', name: 'B 组织', ownerUserId: 'user_b' });

    // 平台默认 + 各组织自有规则
    upsertRuleScope(db, {
      id: 'rs_p1',
      ruleId: 'security.secrets-scan',
      orgId: null,
      version: '1.0',
      enabled: true,
      contentSha: 'sha_platform',
    });
    upsertRuleScope(db, {
      id: 'rs_a1',
      ruleId: 'typescript.naming',
      orgId: 'org_a',
      version: '1.2',
      enabled: true,
      contentSha: 'sha_a',
    });
    upsertRuleScope(db, {
      id: 'rs_b1',
      ruleId: 'python.naming',
      orgId: 'org_b',
      version: '1.1',
      enabled: true,
      contentSha: 'sha_b',
    });

    const scopeA = getEffectiveRuleScope(db, 'org_a');
    const scopeB = getEffectiveRuleScope(db, 'org_b');
    const idsA = scopeA.map((r) => r.rule_id);
    const idsB = scopeB.map((r) => r.rule_id);

    // 各自包含平台默认 + 自己的规则
    expect(idsA).toContain('security.secrets-scan');
    expect(idsA).toContain('typescript.naming');
    expect(idsB).toContain('security.secrets-scan');
    expect(idsB).toContain('python.naming');
    // 跨租户隔离：A 看不到 B 的规则，B 看不到 A 的规则
    expect(idsA).not.toContain('python.naming');
    expect(idsB).not.toContain('typescript.naming');
  });

  it('GIVEN 组织行覆盖平台行 WHEN 同 rule_id THEN 生效版本取组织行', () => {
    const db = createTestDb();
    createOrg(db, { id: 'org_x', name: 'X', ownerUserId: 'user_x' });
    upsertRuleScope(db, {
      id: 'rs_p2',
      ruleId: 'quality.complexity',
      orgId: null,
      version: '1.0',
      enabled: true,
      contentSha: 'sha_platform',
    });
    upsertRuleScope(db, {
      id: 'rs_x2',
      ruleId: 'quality.complexity',
      orgId: 'org_x',
      version: '2.0',
      enabled: false,
      contentSha: 'sha_org',
    });
    const effective = getEffectiveRuleScope(db, 'org_x').find(
      (r) => r.rule_id === 'quality.complexity',
    );
    expect(effective?.version).toBe('2.0');
    expect(effective?.enabled).toBe(0);
    expect(effective?.org_id).toBe('org_x');
  });

  it('GIVEN org_members WHEN 成员查询与用户组织列表 THEN 关系正确且跨组织无泄漏', () => {
    const db = createTestDb();
    createOrg(db, { id: 'org_1', name: '一', ownerUserId: 'u1' });
    createOrg(db, { id: 'org_2', name: '二', ownerUserId: 'u2' });
    addOrgMember(db, { id: 'm1', orgId: 'org_1', userId: 'u1', role: 'owner' });
    addOrgMember(db, { id: 'm2', orgId: 'org_1', userId: 'u2', role: 'member' });

    expect(getOrgMember(db, 'org_1', 'u2')?.role).toBe('member');
    expect(getOrgMember(db, 'org_2', 'u1')).toBeUndefined();
    const orgsOfU2 = listOrgsForUser(db, 'u2');
    expect(orgsOfU2).toHaveLength(1);
    expect(orgsOfU2[0].id).toBe('org_1');
  });

  it('GIVEN 项目画像快照 WHEN 保存后读取 THEN upsert 幂等且 features 往返一致（验收 2/3 前置）', () => {
    const db = createTestDb();
    createOrg(db, { id: 'org_p', name: 'P', ownerUserId: 'user_p' });
    createProject(db, { id: 'proj_1', name: 'demo', path: '/tmp/demo' });
    linkProjectToOrg(db, 'proj_1', 'org_p');
    expect(getProjectOrgId(db, 'proj_1')).toBe('org_p');

    saveProjectFeatures(db, {
      id: 'pf_1',
      projectId: 'proj_1',
      framework: 'NestJS',
      language: 'typescript',
      features: ['typescript', 'NestJS'],
    });
    saveProjectFeatures(db, {
      id: 'pf_1b',
      projectId: 'proj_1',
      framework: 'NestJS',
      language: 'typescript',
      features: ['typescript', 'NestJS', 'backend'],
    });

    const row = getProjectFeatures(db, 'proj_1');
    expect(row).toBeDefined();
    // upsert：仍只有一行，且取最新值
    const count = (db.prepare('SELECT COUNT(*) AS c FROM project_features').get() as { c: number })
      .c;
    expect(count).toBe(1);
    expect(JSON.parse(row!.features_json)).toEqual(['typescript', 'NestJS', 'backend']);
  });

  it('GIVEN 平台行二次 upsert WHEN 同 rule_id org_id NULL THEN 仅 1 行且取最新版本（SQLite NULL 互异回归）', () => {
    const db = createTestDb();
    upsertRuleScope(db, {
      id: 'rs_dup_1',
      ruleId: 'platform-dup',
      orgId: null,
      version: '1.0.0',
      enabled: true,
      contentSha: 'sha_v1',
    });
    upsertRuleScope(db, {
      id: 'rs_dup_2',
      ruleId: 'platform-dup',
      orgId: null,
      version: '1.0.1',
      enabled: true,
      contentSha: 'sha_v2',
    });
    const rows = db
      .prepare('SELECT version, enabled FROM rule_scope WHERE rule_id = ?')
      .all('platform-dup') as Array<{ version: string; enabled: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe('1.0.1');
    expect(rows[0]!.enabled).toBe(1);
  });

  it('GIVEN 平台行与组织行同 rule_id WHEN 各自 upsert THEN 2 行共存互不覆盖', () => {
    const db = createTestDb();
    createOrg(db, { id: 'org_a', name: 'A 组织', ownerUserId: 'user_a' });
    upsertRuleScope(db, {
      id: 'rs_p',
      ruleId: 'coexist-rule',
      orgId: null,
      version: '1.0',
      enabled: true,
      contentSha: 'sha_platform',
    });
    upsertRuleScope(db, {
      id: 'rs_o',
      ruleId: 'coexist-rule',
      orgId: 'org_a',
      version: '2.0',
      enabled: false,
      contentSha: 'sha_org',
    });
    const rows = db
      .prepare('SELECT org_id, version, enabled FROM rule_scope WHERE rule_id = ? ORDER BY org_id')
      .all('coexist-rule') as Array<{ org_id: string | null; version: string; enabled: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.org_id).toBeNull();
    expect(rows[0]!.version).toBe('1.0');
    expect(rows[1]!.org_id).toBe('org_a');
    expect(rows[1]!.version).toBe('2.0');
    expect(rows[1]!.enabled).toBe(0);
  });
});
