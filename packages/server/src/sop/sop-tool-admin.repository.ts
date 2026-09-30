import { randomUUID } from 'node:crypto';
import {
  getToolPackage,
  listToolPackageVersions,
  listToolPackages,
  saveToolPackage,
  saveToolPackageVersion,
  softDeleteToolPackage,
} from '@zh/db';
import type { DbConnection, ToolPackageRow } from '@zh/db';
import { hashToolRuleFiles } from '@zh/kernel';
import type { ToolRuleFile } from '@zh/kernel';
import { AdminError, audit } from './sop-content-admin.shared';
import { SopContentRepository } from './sop-content.repository';

const TOOL_STATUSES = new Set(['active', 'deprecated', 'disabled']);

/** 工具包写入入参（C4 /admin/tools） */
export interface SaveToolPackageInput {
  toolId: string;
  files: ToolRuleFile[];
  languages?: string[];
  frameworks?: string[];
  description?: string;
  status?: string;
}

/**
 * SopToolAdminRepository — SOP 工具包管理写路径（/admin/tools 等）
 *
 * 继承 SopContentRepository 复用懒连接/迁移/读方法；所有写操作：
 * - 多语句操作包在 DbConnection.transaction 中（all-or-nothing）
 * - 一律写 content_audit_log（operator='admin'，P0 无账号体系）
 * - 工具包 sha256 恒为 hashToolRuleFiles(files)（硬约束 H1 同口径）
 * - 校验失败抛 AdminError（中文消息），由服务/控制器层翻译为 HTTP 异常
 */
export class SopToolAdminRepository extends SopContentRepository {
  private requireDb(): ReturnType<DbConnection['getDb']> {
    const db = this.tryReadyDb();
    if (!db) throw new AdminError('数据库不可用', 'unavailable');
    return db;
  }

  private requireTool(db: ReturnType<DbConnection['getDb']>, toolId: string): ToolPackageRow {
    const row = getToolPackage(db, toolId);
    if (!row) throw new AdminError('工具包不存在', 'not_found');
    return row;
  }

  /** requireDb() 成功后 dbConn 必已就绪；返回连接供 transaction 使用 */
  private requireConn(): DbConnection {
    this.requireDb();
    const conn = this.dbConn;
    if (!conn) throw new AdminError('数据库不可用', 'unavailable');
    return conn;
  }

  /** upsert 工具包；sha256 = hashToolRuleFiles，version = 1.<sha256 前 12 位>（与读路径同口径） */
  saveToolPackage(input: SaveToolPackageInput): { toolId: string; created: boolean } {
    const db = this.requireDb();
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new AdminError('工具包文件列表不能为空', 'validation');
    }
    if (
      input.files.some((f) => !f || typeof f.filename !== 'string' || typeof f.content !== 'string')
    ) {
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
    audit({
      db,
      entityType: 'tool',
      entityId: input.toolId,
      action: created ? 'create' : 'update',
      detail: `version=${version} sha256=${sha256.slice(0, 12)}`,
    });
    return { toolId: input.toolId, created };
  }

  /** 发布：当前行快照入历史（同版本已存在则跳过）→ 重写当前行 → 审计（原子） */
  publishTool(toolId: string): void {
    const db = this.requireDb();
    const row = this.requireTool(db, toolId);
    this.requireConn().transaction((tx) => {
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
      audit({ db: tx, entityType: 'tool', entityId: toolId, action: 'publish', detail: `version=${row.version}` });
    });
  }

  /** 回滚：从 tool_package_version 恢复为当前行（status → active） */
  rollbackTool(toolId: string, version: string): void {
    const db = this.requireDb();
    const row = this.requireTool(db, toolId);
    const history = listToolPackageVersions(db, toolId).find((v) => v.version === version);
    if (!history) throw new AdminError(`历史版本不存在: ${version}`, 'not_found');
    this.requireConn().transaction((tx) => {
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
      audit({ db: tx, entityType: 'tool', entityId: toolId, action: 'rollback', detail: `回滚到 ${version}` });
    });
  }

  /** 软删：status → disabled（保留行与历史） */
  deleteTool(toolId: string): void {
    const db = this.requireDb();
    this.requireTool(db, toolId);
    softDeleteToolPackage(db, toolId);
    audit({ db, entityType: 'tool', entityId: toolId, action: 'delete', detail: '软删（disabled）' });
  }

  listTools(): ToolPackageRow[] {
    return listToolPackages(this.requireDb());
  }

  getTool(toolId: string): ToolPackageRow {
    return this.requireTool(this.requireDb(), toolId);
  }

  /** 工具历史版本列表（管理后台回滚选择用） */
  listToolVersions(toolId: string): Array<{ version: string; releasedAt: string }> {
    return listToolPackageVersions(this.requireDb(), toolId).map((v) => ({
      version: v.version,
      releasedAt: v.released_at,
    }));
  }
}