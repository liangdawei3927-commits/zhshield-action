import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DbConnection, listRuleContent, listToolPackages } from '@zh/db';
import type { RuleContentRow, ToolPackageRow } from '@zh/db';
import { computeRuleContentSha, hashToolRuleFiles } from '@zh/kernel';
import type { SopRule, ToolRuleFile } from '@zh/kernel';
import { resolveMigrationsDir } from '../tenancy/tenancy.service';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 工具包条目（files 已解析为远端同步契约形态） */
export interface ToolPackEntry {
  toolId: string;
  version: string;
  sha256: string;
  files: ToolRuleFile[];
}

/**
 * SopContentRepository — C3 规则内容仓库（迁移 010）读取方
 *
 * 服务端从 rule_content / tool_package 读库替代内置 YAML/tool-packs。
 * 懒连接 + 迁移（与 TenancyService 同构）；DB 不可用/空 → 调用方降级文件系统。
 *
 * 纪律：
 * - 只读仓库，不暴露任何写方法；C4 写路径在 SopContentAdminRepository（子类）中
 * - 懒连接：首次访问才建连并跑迁移，不阻塞 Nest 启动
 * - DB 不可用返回 null（调用方降级），绝不 throw 污染服务启动
 * - content_sha 与 files sha256 均为 H1 校验口径（computeRuleContentSha / hashToolRuleFiles），
 *   读取时校验漂移仅 warn（fail-open），库为源的完整性由审计链保证
 */
@Injectable()
export class SopContentRepository implements OnModuleDestroy {
  private readonly logger = new Logger(SopContentRepository.name);
  protected dbConn: DbConnection | null = null;

  protected ensureReady(): void {
    if (this.dbConn) return;
    const dbPath =
      process.env.ZH_SERVER_DB ??
      path.join(os.homedir(), '.zhshield', 'server', 'zh-codeshield.db');
    const conn = new DbConnection({ dbPath, walMode: true });
    conn.connect();
    const migrationsDir = resolveMigrationsDir();
    if (fs.existsSync(migrationsDir)) {
      conn.migrate(migrationsDir);
    } else {
      this.logger.warn(`迁移目录不存在，跳过迁移: ${migrationsDir}`);
    }
    this.dbConn = conn;
    this.logger.log(`Content repository ready: ${dbPath}`);
  }

  /** DB 可用返回 Database 实例，不可用返回 null（调用方降级） */
  protected tryReadyDb(): ReturnType<DbConnection['getDb']> | null {
    try {
      this.ensureReady();
      return this.dbConn!.getDb();
    } catch (err) {
      this.logger.warn(
        `Content repository unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  onModuleDestroy(): void {
    this.dbConn?.close();
    this.dbConn = null;
  }

  // ─── 规则本体（rule_content）──────────────────────────────

  /**
   * 读全部非禁用规则（status !== 'disabled'），复活 JSON 往返丢失的 Date 字段。
   * DB 不可用 → null；可用但 0 行 → []（空库降级由调用方处理）。
   */
  getAllRules(): SopRule[] | null {
    const db = this.tryReadyDb();
    if (!db) return null;
    try {
      const rows = listRuleContent(db).filter((r) => r.status !== 'disabled');
      const rules = rows.map((row) => this.rowToRule(row));
      const drift = rows.filter((row, i) => row.content_sha !== computeRuleContentSha(rules[i]));
      if (drift.length > 0) {
        this.logger.warn(`content_sha 漂移 ${drift.length} 条（rule_id: ${drift.map((d) => d.rule_id).join(',')}）`);
      }
      this.logger.log(`Loaded ${rules.length} SOP rules from content repository`);
      return rules;
    } catch (err) {
      this.logger.warn(
        `Failed to read rule_content: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private rowToRule(row: RuleContentRow): SopRule {
    const rule = JSON.parse(row.content) as SopRule;
    // JSON.stringify(rule) 失去 Date 原型，registry evaluateLifecycle 依赖 createdAt.getTime()，
    // 必须复活；computeRuleContentSha 排除时间字段，复活不影响 H1 校验。
    return {
      ...rule,
      createdAt: new Date(rule.createdAt),
      updatedAt: new Date(rule.updatedAt),
      lastUsedAt: rule.lastUsedAt ? new Date(rule.lastUsedAt) : undefined,
    };
  }

  // ─── 工具包（tool_package）────────────────────────────────

  /**
   * 读当前生效工具包（status !== 'disabled'），files 解析为 {filename, content} 契约。
   * DB 不可用 → null；可用但 0 行 → []。
   */
  listActiveToolPacks(): ToolPackEntry[] | null {
    const db = this.tryReadyDb();
    if (!db) return null;
    try {
      const rows = listToolPackages(db).filter((r) => r.status !== 'disabled');
      const entries = rows.map((row) => this.rowToToolPack(row));
      const drift = entries.filter((e, i) => e.sha256 !== hashToolRuleFiles(e.files));
      if (drift.length > 0) {
        this.logger.warn(`tool_package sha256 漂移 ${drift.length} 条（tool_id: ${drift.map((d) => d.toolId).join(',')}）`);
      }
      this.logger.log(`Loaded ${entries.length} tool packs from content repository`);
      return entries;
    } catch (err) {
      this.logger.warn(
        `Failed to read tool_package: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private rowToToolPack(row: ToolPackageRow): ToolPackEntry {
    return {
      toolId: row.tool_id,
      version: row.version,
      sha256: row.sha256,
      files: JSON.parse(row.files_json) as ToolRuleFile[],
    };
  }
}