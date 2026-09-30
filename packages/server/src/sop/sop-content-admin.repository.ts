import { randomUUID } from 'node:crypto';
import {
  getRuleContent,
  getRuleContentVersion,
  listRuleContent,
  listRuleContentVersions,
  saveRuleContent,
  saveRuleContentVersion,
  setRuleContentStatus,
  softDeleteRuleContent,
  upsertRuleScope,
} from '@zh/db';
import type { DbConnection, RuleContentRow, SaveRuleContentParams } from '@zh/db';
import { computeRuleContentSha } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';
import { AdminError, audit } from './sop-content-admin.shared';
import { SopContentRepository } from './sop-content.repository';

const MAX_RULE_CONTENT_BYTES = 100 * 1024;
const RULE_STATUSES = new Set(['draft', 'trial', 'active', 'deprecated', 'disabled']);
const PUBLISHABLE_STATUSES = new Set(['draft', 'trial']);
const SEMVER_PATCH_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** 语义化版本 patch 段递增：1.0.0 → 1.0.1；无法解析时回退 1.0.1 */
function bumpPatchVersion(version: string): string {
  const match = SEMVER_PATCH_RE.exec(version);
  if (!match) return '1.0.1';
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** 从 rule_content 行构造 saveRuleContent 入参（publish/rollback 复用，避免重复展开 20 字段） */
function ruleContentParams(
  row: RuleContentRow,
  overrides: { status: string; version: string; content: string; contentSha: string },
): SaveRuleContentParams {
  return {
    id: row.id,
    ruleId: row.rule_id,
    domain: row.domain,
    action: row.action,
    source: row.source,
    name: row.name,
    description: row.description,
    severity: row.severity,
    status: overrides.status,
    executionMode: row.execution_mode,
    tags: JSON.parse(row.tags),
    applicableEngines: JSON.parse(row.applicable_engines),
    languages: JSON.parse(row.languages),
    frameworks: JSON.parse(row.frameworks),
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    content: overrides.content,
    contentSha: overrides.contentSha,
    version: overrides.version,
    updatedBy: 'admin',
  };
}

/** 平台行（org_id IS NULL）幂等写入：UPDATE 命中则更新，未命中则 INSERT（SQLite UNIQUE 对 NULL 互异，ON CONFLICT 不生效） */
function upsertPlatformScope(
  db: ReturnType<DbConnection['getDb']>,
  params: {
    id: string;
    ruleId: string;
    version: string;
    enabled: boolean;
    contentSha: string | null;
    source?: string;
  },
): void {
  const { version, enabled, contentSha, source } = params;
  const res = db
    .prepare(
      `UPDATE rule_scope SET version = ?, enabled = ?, content_sha = ?, source = ?, published_at = CURRENT_TIMESTAMP
       WHERE rule_id = ? AND org_id IS NULL`,
    )
    .run(version, enabled ? 1 : 0, contentSha, source ?? 'manual', params.ruleId);
  if (res.changes === 0) {
    db.prepare(
      `INSERT INTO rule_scope (id, rule_id, org_id, version, enabled, content_sha, source)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    ).run(params.id, params.ruleId, version, enabled ? 1 : 0, contentSha, source ?? 'manual');
  }
}

/**
 * SopRuleAdminRepository — SOP 规则管理写路径（/admin/rules 等）
 *
 * 继承 SopContentRepository 复用懒连接/迁移/读方法；所有写操作：
 * - 多语句操作包在 DbConnection.transaction 中（all-or-nothing）
 * - 一律写 content_audit_log（operator='admin'，P0 无账号体系）
 * - 规则 content_sha 恒为 computeRuleContentSha(SopRule)（硬约束 H1）
 * - 规则发布写 rule_scope 平台行（org_id = NULL），严禁 org 行
 * - 校验失败抛 AdminError（中文消息），由服务/控制器层翻译为 HTTP 异常
 */
export class SopRuleAdminRepository extends SopContentRepository {
  private requireDb(): ReturnType<DbConnection['getDb']> {
    const db = this.tryReadyDb();
    if (!db) throw new AdminError('数据库不可用', 'unavailable');
    return db;
  }

  private requireRule(db: ReturnType<DbConnection['getDb']>, ruleId: string): RuleContentRow {
    const row = getRuleContent(db, ruleId);
    if (!row) throw new AdminError('规则不存在', 'not_found');
    return row;
  }

  /** requireDb() 成功后 dbConn 必已就绪；返回连接供 transaction 使用 */
  private requireConn(): DbConnection {
    this.requireDb();
    const conn = this.dbConn;
    if (!conn) throw new AdminError('数据库不可用', 'unavailable');
    return conn;
  }

  /** upsert 规则本体；新规则 version=1.0.0，更新置草稿态（蓝图 §3.1：PUT 只改草稿） */
  saveRule(rule: SopRule): { ruleId: string; created: boolean } {
    const db = this.requireDb();
    if (
      !rule ||
      typeof rule !== 'object' ||
      !rule.content ||
      typeof rule.content !== 'object' ||
      Array.isArray(rule.content)
    ) {
      throw new AdminError('规则内容必须为对象', 'validation');
    }
    const serialized = JSON.stringify(rule);
    if (Buffer.byteLength(serialized, 'utf-8') > MAX_RULE_CONTENT_BYTES) {
      throw new AdminError('规则内容超过 100KB 上限', 'validation');
    }
    const contentSha = computeRuleContentSha(rule);
    const existing = getRuleContent(db, rule.id);
    const created = !existing;
    saveRuleContent(db, {
      id: rule.id,
      ruleId: rule.id,
      domain: rule.domain,
      action: rule.action,
      source: rule.source,
      name: rule.name,
      description: rule.description ?? null,
      severity: rule.severity,
      status: existing ? 'draft' : (rule.status ?? 'draft'),
      executionMode: rule.executionMode,
      tags: rule.tags,
      applicableEngines: rule.applicableEngines,
      languages: rule.serves?.languages ?? [],
      frameworks: [],
      content: serialized,
      contentSha,
      version: existing?.version ?? '1.0.0',
      createdBy: 'admin',
      updatedBy: 'admin',
    });
    audit({
      db,
      entityType: 'rule',
      entityId: rule.id,
      action: created ? 'create' : 'update',
      detail: `version=${existing?.version ?? '1.0.0'} sha=${contentSha.slice(0, 12)}`,
    });
    return { ruleId: rule.id, created };
  }

  /** 发布：历史快照 → 版本递增 + active → rule_scope 平台行 → 审计（原子） */
  publishRule(ruleId: string): void {
    const db = this.requireDb();
    const row = this.requireRule(db, ruleId);
    if (!PUBLISHABLE_STATUSES.has(row.status)) {
      throw new AdminError(`仅 draft/trial 状态可发布，当前状态: ${row.status}`, 'validation');
    }
    const nextVersion = bumpPatchVersion(row.version);
    const rule = JSON.parse(row.content) as SopRule;
    const contentSha = computeRuleContentSha(rule);
    this.requireConn().transaction((tx) => {
      saveRuleContentVersion(tx, {
        id: randomUUID(),
        ruleId,
        version: row.version,
        contentSha: row.content_sha,
        content: row.content,
        statusAtRelease: row.status,
        releasedBy: 'admin',
      });
      saveRuleContent(
        tx,
        ruleContentParams(row, {
          status: 'active',
          version: nextVersion,
          content: row.content,
          contentSha: row.content_sha,
        }),
      );
      upsertRuleScope(tx, {
        id: randomUUID(),
        ruleId,
        orgId: null,
        version: nextVersion,
        enabled: true,
        contentSha,
        source: 'manual',
      });
      audit({ db: tx, entityType: 'rule', entityId: ruleId, action: 'publish', detail: `${row.version} -> ${nextVersion}` });
    });
  }

  /** 回滚：从历史快照恢复 content/version/contentSha 到当前行，并同步 rule_scope 平台行（status → active） */
  rollbackRule(ruleId: string, version: string): void {
    const db = this.requireDb();
    const row = this.requireRule(db, ruleId);
    const history = getRuleContentVersion(db, ruleId, version);
    if (!history) throw new AdminError(`历史版本不存在: ${version}`, 'not_found');
    this.requireConn().transaction((tx) => {
      saveRuleContent(
        tx,
        ruleContentParams(row, {
          status: 'active',
          version: history.version,
          content: history.content,
          contentSha: history.content_sha,
        }),
      );
      upsertPlatformScope(tx, {
        id: randomUUID(),
        ruleId,
        version: history.version,
        enabled: true,
        contentSha: history.content_sha,
        source: 'manual',
      });
      audit({ db: tx, entityType: 'rule', entityId: ruleId, action: 'rollback', detail: `回滚到 ${version}` });
    });
  }

  /** 改状态：仅 trial/active/deprecated/disabled */
  setRuleStatus(ruleId: string, status: string): void {
    const db = this.requireDb();
    const row = this.requireRule(db, ruleId);
    if (!RULE_STATUSES.has(status) || status === 'draft') {
      throw new AdminError(`非法状态: ${status}`, 'validation');
    }
    setRuleContentStatus(db, ruleId, status);
    audit({ db, entityType: 'rule', entityId: ruleId, action: 'status_change', detail: `${row.status} -> ${status}` });
  }

  /** 软删：status → deprecated + rule_scope 平台行下架（enabled=0，停止下发） */
  deleteRule(ruleId: string): void {
    const db = this.requireDb();
    const row = this.requireRule(db, ruleId);
    this.requireConn().transaction((tx) => {
      softDeleteRuleContent(tx, ruleId);
      upsertPlatformScope(tx, {
        id: randomUUID(),
        ruleId,
        version: row.version,
        contentSha: row.content_sha,
        enabled: false,
        source: 'manual',
      });
      audit({ db: tx, entityType: 'rule', entityId: ruleId, action: 'delete', detail: '软删（deprecated）' });
    });
  }

  listRules(): RuleContentRow[] {
    return listRuleContent(this.requireDb());
  }

  getRule(ruleId: string): RuleContentRow {
    return this.requireRule(this.requireDb(), ruleId);
  }

  /** 规则历史版本列表（管理后台回滚选择用） */
  listRuleVersions(ruleId: string): Array<{ version: string; releasedAt: string }> {
    return listRuleContentVersions(this.requireDb(), ruleId).map((v) => ({
      version: v.version,
      releasedAt: v.released_at,
    }));
  }
}