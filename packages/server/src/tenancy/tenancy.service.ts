import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  DbConnection,
  addOrgMember,
  createOrg,
  createProject,
  getEffectiveRuleScope,
  getOrg,
  getOrgMember,
  getProjectFeatures,
  getProjectOrgId,
  linkProjectToOrg,
  saveProjectFeatures,
  upsertRuleScope,
} from '@zh/db';
import type { OrgRow, RuleScopeRow, ProjectFeatureRow } from '@zh/db';
import { isToolInScope } from '@zh/shared';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'node:crypto';

/** 结构兼容的画像最小投影（与 @zh/shared ScopeProfile / kernel ProjectFeature 对齐） */
export interface ScopeProfileLike {
  framework?: string;
  language?: string;
  features?: string[];
}

/** 定位 @zh/db 注入副本内的 migrations 目录（副本含 009 起的租户迁移） */
export function resolveMigrationsDir(): string {
  const entry = require.resolve('@zh/db');
  return path.join(path.dirname(entry), '..', 'migrations');
}

/**
 * TenancyService — M3 轻量 Org 多租户服务
 *
 * 职责（M3 规格 §二/§三/§四）：
 * - Org/成员/项目/画像快照/规则 scope 的持久化（@zh/db，迁移 009）
 * - T1 核心：按画像 + 租户 resolve 本项目应加载的规则清单与工具清单
 *
 * 租户隔离纪律：所有读取显式带 org_id；平台默认（org_id NULL）为兜底，
 * 组织行覆盖同 rule_id 的平台行（getEffectiveRuleScope 合并）。
 */
@Injectable()
export class TenancyService implements OnModuleDestroy {
  private readonly logger = new Logger(TenancyService.name);
  private dbConn: DbConnection | null = null;

  private ensureReady(): void {
    if (this.dbConn) return;
    const dbPath =
      process.env.ZH_SERVER_DB ??
      path.join(os.homedir(), '.zhshield', 'server', 'zh-codeshield.db');
    this.dbConn = new DbConnection({ dbPath, walMode: true });
    this.dbConn.connect();
    const migrationsDir = resolveMigrationsDir();
    if (fs.existsSync(migrationsDir)) {
      this.dbConn.migrate(migrationsDir);
    } else {
      this.logger.warn(`迁移目录不存在，跳过迁移: ${migrationsDir}`);
    }
    this.logger.log(`Tenancy persistence ready: ${dbPath}`);
  }

  private getDb() {
    this.ensureReady();
    return this.dbConn!.getDb();
  }

  onModuleDestroy(): void {
    this.dbConn?.close();
  }

  // ─── Org / 成员 ───────────────────────────────────────────

  createOrg(name: string, ownerUserId: string): OrgRow {
    const db = this.getDb();
    const id = randomUUID();
    createOrg(db, { id, name, ownerUserId });
    addOrgMember(db, { id: randomUUID(), orgId: id, userId: ownerUserId, role: 'owner' });
    const org = getOrg(db, id)!;
    this.logger.log(`Org created: ${org.name} (${org.id})`);
    return org;
  }

  assertMember(orgId: string, userId: string): void {
    if (!getOrgMember(this.getDb(), orgId, userId)) {
      throw new Error(`user ${userId} is not a member of org ${orgId}`);
    }
  }

  // ─── 项目画像（T0 注册即画像）─────────────────────────────

  /**
   * 组织内 upsert 项目并保存画像快照。
   * 云端无真实路径，projects.path 用合成唯一值（org:orgId:projectId）满足 NOT NULL UNIQUE。
   */
  upsertProjectWithFeatures(
    orgId: string,
    projectId: string,
    input: { name?: string; framework?: string; language?: string; features?: string[] },
  ): ProjectFeatureRow {
    const db = this.getDb();
    const existing = getProjectOrgId(db, projectId);
    if (!existing) {
      createProject(db, {
        id: projectId,
        name: input.name ?? projectId,
        path: `org:${orgId}:${projectId}`,
      });
    }
    linkProjectToOrg(db, projectId, orgId);
    saveProjectFeatures(db, {
      id: randomUUID(),
      projectId,
      framework: input.framework ?? null,
      language: input.language ?? null,
      features: input.features ?? [],
    });
    return getProjectFeatures(db, projectId)!;
  }

  // ─── 规则 scope 管理（主通道：运营侧 manual）──────────────

  /** 平台默认（org_id NULL）或某组织的规则快照写入（幂等 upsert） */
  publishRuleScope(input: {
    ruleId: string;
    orgId?: string | null;
    version: string;
    enabled?: boolean;
    contentSha?: string | null;
  }): void {
    upsertRuleScope(this.getDb(), {
      id: randomUUID(),
      ruleId: input.ruleId,
      orgId: input.orgId ?? null,
      version: input.version,
      enabled: input.enabled ?? true,
      contentSha: input.contentSha ?? null,
      source: 'manual',
    });
  }

  // ─── T1 核心：按画像 + 租户 resolve ───────────────────────

  /** 本租户生效的规则清单（平台默认兜底 + 组织覆盖，仅 enabled） */
  resolveRules(
    orgId: string,
    currentVersions?: Record<string, string>,
  ): { rules: RuleScopeRow[]; changed: string[] } {
    const enabled = getEffectiveRuleScope(this.getDb(), orgId).filter((r) => r.enabled === 1);
    const changed = enabled
      .filter((r) => !currentVersions || currentVersions[r.rule_id] !== r.version)
      .map((r) => r.rule_id);
    return { rules: enabled, changed };
  }

  /** 本项目应下发的工具清单：isToolInScope 画像裁剪（security 恒含，缺省全量） */
  resolveTools(toolIds: readonly string[], feature: ScopeProfileLike | undefined): string[] {
    return toolIds.filter((toolId) => isToolInScope(toolId, feature));
  }
}
