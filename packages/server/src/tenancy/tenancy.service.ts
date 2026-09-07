import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  DbConnection,
  addOrgMember,
  createOrg,
  createProject,
  deleteProjectFeatures,
  getEffectiveRuleScope,
  getOrg,
  getOrgMember,
  getProjectFeatures,
  getProjectOrgId,
  getRuleContent,
  linkProjectToOrg,
  listToolPackages,
  saveProjectFeatures,
  upsertRuleScope,
} from '@zh/db';
import type { OrgRow, RuleScopeRow, ProjectFeatureRow } from '@zh/db';
import { isToolInScope, isToolLanguagesMatch } from '@zh/shared';
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

/** resolve 下发的工具条目：toolId + 适用语言（tool_package.languages，JSON 数组） */
export interface ResolvedTool {
  toolId: string;
  languages: string[];
}

/** 解析 languages JSON 数组（tool_package / rule_content 列）；损坏/非数组 → 空数组（保守） */
function parseLanguages(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
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

  /**
   * 注销组织内项目的云端画像（T0 注册的对称镜像）。
   * 语义：删除该 project 的画像快照行；若 projects 行归属该 org 且已无画像，
   * 一并删除 projects 行，保证注销后 resolve 不再返回该项目画像。
   */
  removeProjectFeatures(orgId: string, projectId: string): void {
    const db = this.getDb();
    deleteProjectFeatures(db, projectId);
    const ownerOrgId = getProjectOrgId(db, projectId);
    if (ownerOrgId === orgId && !getProjectFeatures(db, projectId)) {
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    }
    this.logger.debug(`T0 画像已注销: org=${orgId} project=${projectId}`);
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

  /** 本租户生效的规则清单（平台默认兜底 + 组织覆盖，仅 enabled），附 rule_content.languages（无行 → 空数组） */
  resolveRules(
    orgId: string,
    currentVersions?: Record<string, string>,
  ): { rules: Array<RuleScopeRow & { languages: string[] }>; changed: string[] } {
    const db = this.getDb();
    const enabled = getEffectiveRuleScope(db, orgId).filter((r) => r.enabled === 1);
    const rules = enabled.map((r) => ({
      ...r,
      languages: parseLanguages(getRuleContent(db, r.rule_id)?.languages ?? '[]'),
    }));
    // 差量判定：客户端上报值与 content_sha 一致 → 内容未变（免重发）；
    // content_sha 缺失时退化为 version 比较；未上报 currentVersions → 全部视为变更（兼容旧客户端）。
    const changed = rules
      .filter((r) => {
        const local = currentVersions?.[r.rule_id];
        if (local === undefined) return true;
        if (r.content_sha != null && local === r.content_sha) return false;
        return local !== r.version;
      })
      .map((r) => r.rule_id);
    return { rules, changed };
  }

  /** 本项目应下发的工具清单：tool_package 表（active）→ languages 元数据投影；空表/不可用回退静态全集（languages 恒空，保持 isToolInScope 旧 map） */
  resolveTools(
    staticToolIds: readonly string[],
    feature: ScopeProfileLike | undefined,
  ): ResolvedTool[] {
    const fromDb = this.readEnabledToolPackages();
    if (fromDb && fromDb.length > 0) {
      // R3c：DB 有 tool_package 行（languages 真实存在）→ languages 交集投影
      return fromDb.filter((t) => isToolLanguagesMatch(t.languages, feature));
    }
    // 静态回退（DB 空表/不可用，languages 恒空）→ 仍 isToolInScope 旧 map，零改动（§2.2 风险行）
    return staticToolIds
      .map((toolId) => ({ toolId, languages: [] }))
      .filter((t) => isToolInScope(t.toolId, feature));
  }

  /** 读 tool_package 全部非禁用工具（含 languages）；DB 不可用返回 null */
  private readEnabledToolPackages(): ResolvedTool[] | null {
    try {
      return listToolPackages(this.getDb())
        .filter((r) => r.status !== 'disabled')
        .map((r) => ({ toolId: r.tool_id, languages: parseLanguages(r.languages) }));
    } catch (err) {
      this.logger.warn(
        `tool_package 读取失败，降级静态工具全集: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
