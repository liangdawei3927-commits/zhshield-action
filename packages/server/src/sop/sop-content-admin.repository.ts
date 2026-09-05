import { randomUUID } from 'node:crypto';
import {
  appendAuditLog,
  DbConnection,
  getRuleContent,
  getRuleContentVersion,
  getToolPackage,
  listRuleContent,
  listRuleContentVersions,
  listToolPackageVersions,
  listToolPackages,
  saveRuleContent,
  saveRuleContentVersion,
  saveToolPackage,
  saveToolPackageVersion,
  setRuleContentStatus,
  softDeleteRuleContent,
  softDeleteToolPackage,
  upsertRuleScope,
} from '@zh/db';
import type { RuleContentRow, SaveRuleContentParams, ToolPackageRow } from '@zh/db';
import { computeRuleContentSha, hashToolRuleFiles } from '@zh/kernel';
import type { SopRule, ToolRuleFile } from '@zh/kernel';
import { SopContentRepository } from './sop-content.repository';

/** 管理操作错误分类：validation → 400，not_found → 404，unavailable → 503 */
export type AdminErrorKind = 'validation' | 'not_found' | 'unavailable';

/** 仓库层抛出的管理操作错误（控制器/服务层翻译为 Nest HTTP 异常） */
export class AdminError extends Error {
  constructor(
    message: string,
    readonly kind: AdminErrorKind,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

const MAX_RULE_CONTENT_BYTES = 100 * 1024;
const RULE_STATUSES = new Set(['draft', 'trial', 'active', 'deprecated', 'disabled']);
const PUBLISHABLE_STATUSES = new Set(['draft', 'trial']);
const TOOL_STATUSES = new Set(['active', 'deprecated', 'disabled']);

/** 语义化版本 patch 段递增：1.0.0 → 1.0.1；无法解析时回退 1.0.1 */
function bumpPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return '1.0.1';
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** 工具包写入入参（C4 /admin/tools） */
export interface SaveToolPackageInput {
  toolId: string;
  files: ToolRuleFile[];
  languages?: string[];
  frameworks?: string[];
  description?: string;
  status?: string;
}

/** 写审计日志（operator 恒为 admin，P0 无账号体系） */
function audit(
  db: ReturnType<DbConnection['getDb']>,
  entityType: 'rule' | 'tool',
  entityId: string,
  action: string,
  detail: string,
): void {
  appendAuditLog(db, { id: randomUUID(), entityType, entityId, action, detail, operator: 'admin' });
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
  params: { id: string; ruleId: string; version: string; enabled: boolean; contentSha: string | null; source?: string },
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
 * SopContentAdminRepository — C4 管理写路径（/admin/*）
 *
 * 继承 SopContentRepository 复用懒连接/迁移/读方法；所有写操作：
 * - 多语句操作包在 DbConnection.transaction 中（all-or-nothing）
 * - 一律写 content_audit_log（operator='admin'，P0 无账号体系）
 * - 规则 content_sha 恒为 computeRuleContentSha(SopRule)（硬约束 H1）
 * - 规则发布写 rule_scope 平台行（org_id = NULL），严禁 org 行
 * - 校验失败抛 AdminError（中文消息），由服务/控制器层翻译为 HTTP 异常
 */
export class SopContentAdminRepository extends SopContentRepository {
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

  private requireTool(db: ReturnType<DbConnection['getDb']>, toolId: string): ToolPackageRow {
    const row = getToolPackage(db, toolId);
    if (!row) throw new AdminError('工具包不存在', 'not_found');
    return row;
  }

  /** upsert 规则本体；新规则 version=1.0.0，更新置草稿态（蓝图 §3.1：PUT 只改草稿） */
  saveRule(rule: SopRule): { ruleId: string; created: boolean } {
    const db = this.requireDb();
    if (!rule || typeof rule !== 'object' || !rule.content || typeof rule.content !== 'object' || Array.isArray(rule.content)) {
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
    audit(
      db,
      'rule',
      rule.id,
      created ? 'create' : 'update',
      `version=${existing?.version ?? '1.0.0'} sha=${contentSha.slice(0, 12)}`,
    );
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
    this.dbConn!.transaction((tx) => {
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
      audit(tx, 'rule', ruleId, 'publish', `${row.version} -> ${nextVersion}`);
    });
  }

  /** 回滚：从历史快照恢复 content/version/contentSha 到当前行，并同步 rule_scope 平台行（status → active） */
  rollbackRule(ruleId: string, version: string): void {
    const db = this.requireDb();
    const row = this.requireRule(db, ruleId);
    const history = getRuleContentVersion(db, ruleId, version);
    if (!history) throw new AdminError(`历史版本不存在: ${version}`, 'not_found');
    this.dbConn!.transaction((tx) => {
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
      audit(tx, 'rule', ruleId, 'rollback', `回滚到 ${version}`);
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
    audit(db, 'rule', ruleId, 'status_change', `${row.status} -> ${status}`);
  }

  /** 软删：status → deprecated + rule_scope 平台行下架（enabled=0，停止下发） */
  deleteRule(ruleId: string): void {
    const db = this.requireDb();
    const row = this.requireRule(db, ruleId);
    this.dbConn!.transaction((tx) => {
      softDeleteRuleContent(tx, ruleId);
      upsertPlatformScope(tx, {
        id: randomUUID(),
        ruleId,
        version: row.version,
        contentSha: row.content_sha,
        enabled: false,
        source: 'manual',
      });
      audit(tx, 'rule', ruleId, 'delete', '软删（deprecated）');
    });
  }

  /** upsert 工具包；sha256 = hashToolRuleFiles，version = 1.<sha256 前 12 位>（与读路径同口径） */
  saveToolPackage(input: SaveToolPackageInput): { toolId: string; created: boolean } {
    const db = this.requireDb();
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new AdminError('工具包文件列表不能为空', 'validation');
    }
    if (input.files.some((f) => !f || typeof f.filename !== 'string' || typeof f.content !== 'string')) {
      throw new AdminError('工具包文件条目必须为 {filename, content}', 'validation');
    }
    if (input.status !== undefined && !TOOL_STATUSES.has(input.status)) {
      throw new AdminError(`非法状态: ${input.status}`, 'validation');
    }
    const sha256 = hashToolRuleFiles(input.files);
    const version = `1.${sha256.slice(0, 12)}`;
    const existing = getToolPackage(db, input.toolId);
    const created = !existing;
    saveToolPackage(db, {
      id: existing?.id ?? `tp-${input.toolId}`,
      toolId: input.toolId,
      version,
      sha256,
      filesJson: JSON.stringify(input.files),
      languages: input.languages ?? [],
      frameworks: input.frameworks ?? [],
      status: input.status ?? 'active',
      description: input.description ?? null,
      createdBy: 'admin',
    });
    audit(
      db,
      'tool',
      input.toolId,
      created ? 'create' : 'update',
      `version=${version} sha256=${sha256.slice(0, 12)}`,
    );
    return { toolId: input.toolId, created };
  }

  /** 发布：当前行快照入历史（同版本已存在则跳过）→ 重写当前行 → 审计（原子） */
  publishTool(toolId: string): void {
    const db = this.requireDb();
    const row = this.requireTool(db, toolId);
    this.dbConn!.transaction((tx) => {
      const alreadySnapshotted = listToolPackageVersions(tx, toolId).some(
        (v) => v.version === row.version,
      );
      if (!alreadySnapshotted) {
        saveToolPackageVersion(tx, {
          id: randomUUID(),
          toolId,
          version: row.version,
          sha256: row.sha256,
          filesJson: row.files_json,
          languages: JSON.parse(row.languages),
          frameworks: JSON.parse(row.frameworks),
          releasedBy: 'admin',
        });
      }
      saveToolPackage(tx, {
        id: row.id,
        toolId,
        version: row.version,
        sha256: row.sha256,
        filesJson: row.files_json,
        languages: JSON.parse(row.languages),
        frameworks: JSON.parse(row.frameworks),
        status: 'active',
        description: row.description,
        createdBy: 'admin',
      });
      audit(tx, 'tool', toolId, 'publish', `version=${row.version}`);
    });
  }

  /** 回滚：从 tool_package_version 恢复为当前行（status → active） */
  rollbackTool(toolId: string, version: string): void {
    const db = this.requireDb();
    const row = this.requireTool(db, toolId);
    const history = listToolPackageVersions(db, toolId).find((v) => v.version === version);
    if (!history) throw new AdminError(`历史版本不存在: ${version}`, 'not_found');
    this.dbConn!.transaction((tx) => {
      saveToolPackage(tx, {
        id: row.id,
        toolId,
        version: history.version,
        sha256: history.sha256,
        filesJson: history.files_json,
        languages: JSON.parse(history.languages),
        frameworks: JSON.parse(history.frameworks),
        status: 'active',
        description: row.description,
        createdBy: 'admin',
      });
      audit(tx, 'tool', toolId, 'rollback', `回滚到 ${version}`);
    });
  }

  /** 软删：status → disabled（保留行与历史） */
  deleteTool(toolId: string): void {
    const db = this.requireDb();
    this.requireTool(db, toolId);
    softDeleteToolPackage(db, toolId);
    audit(db, 'tool', toolId, 'delete', '软删（disabled）');
  }

  listRules(): RuleContentRow[] {
    return listRuleContent(this.requireDb());
  }

  getRule(ruleId: string): RuleContentRow {
    return this.requireRule(this.requireDb(), ruleId);
  }

  listTools(): ToolPackageRow[] {
    return listToolPackages(this.requireDb());
  }

  getTool(toolId: string): ToolPackageRow {
    return this.requireTool(this.requireDb(), toolId);
  }

  /** 规则历史版本列表（管理后台回滚选择用） */
  listRuleVersions(ruleId: string): Array<{ version: string; releasedAt: string }> {
    return listRuleContentVersions(this.requireDb(), ruleId).map((v) => ({
      version: v.version,
      releasedAt: v.released_at,
    }));
  }

  /** 工具历史版本列表（管理后台回滚选择用） */
  listToolVersions(toolId: string): Array<{ version: string; releasedAt: string }> {
    return listToolPackageVersions(this.requireDb(), toolId).map((v) => ({
      version: v.version,
      releasedAt: v.released_at,
    }));
  }
}