import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TenancyService, type ScopeProfileLike } from './tenancy.service';
import { SERVER_TOOL_IDS } from '../sop/tool-rule.controller';
import type { RuleScopeRow } from '@zh/db';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`字段 ${field} 必须为非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`字段 ${field} 必须为字符串`);
  return value;
}

/**
 * 轻量 Org 端点（M3 规格 §四）。鉴权沿用全局 LocalOnlyGuard（本地令牌），
 * 云端账号体系（/auth/register + /auth/login）为后续增量，本模块接口预留 userId 入参。
 */
@ApiTags('tenancy')
@Controller('orgs')
export class OrgsController {
  private readonly logger = new Logger(OrgsController.name);

  constructor(private readonly tenancy: TenancyService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createOrg(@Body() body: { name?: unknown; ownerId?: unknown }): {
    orgId: string;
    name: string;
    ownerId: string;
  } {
    const name = requireString(body.name, 'name');
    const ownerId = requireString(body.ownerId, 'ownerId');
    const org = this.tenancy.createOrg(name, ownerId);
    return { orgId: org.id, name: org.name, ownerId: org.owner_user_id };
  }

  /** T0：注册（添加项目）即提交画像快照 */
  @Put(':orgId/projects/:projectId/features')
  @HttpCode(HttpStatus.OK)
  putProjectFeatures(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body()
    body: {
      userId?: unknown;
      name?: unknown;
      framework?: unknown;
      language?: unknown;
      features?: unknown;
    },
  ): { ok: true; projectId: string; orgId: string } {
    requireString(orgId, 'orgId');
    requireString(projectId, 'projectId');
    const userId = requireString(body.userId, 'userId');
    this.tenancy.assertMember(orgId, userId);
    if (body.features !== undefined && !Array.isArray(body.features)) {
      throw new BadRequestException('字段 features 必须为字符串数组');
    }
    const features = (body.features ?? []).map((f) => String(f));
    this.tenancy.upsertProjectWithFeatures(orgId, projectId, {
      name: optionalString(body.name, 'name'),
      framework: optionalString(body.framework, 'framework'),
      language: optionalString(body.language, 'language'),
      features,
    });
    this.logger.debug(`T0 画像快照已保存: org=${orgId} project=${projectId}`);
    return { ok: true, projectId, orgId };
  }

  /** 运营侧主通道：发布平台默认/组织规则快照（source=manual，M5 回写预留 calibrated） */
  @Post(':orgId/rules')
  @HttpCode(HttpStatus.CREATED)
  publishRule(
    @Param('orgId') orgId: string,
    @Body()
    body: { ruleId?: unknown; version?: unknown; enabled?: unknown; contentSha?: unknown },
  ): { ok: true } {
    requireString(orgId, 'orgId');
    const ruleId = requireString(body.ruleId, 'ruleId');
    const version = requireString(body.version, 'version');
    this.tenancy.publishRuleScope({
      ruleId,
      orgId,
      version,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      contentSha: optionalString(body.contentSha, 'contentSha') ?? null,
    });
    return { ok: true };
  }
}

/** T1 核心：按画像 + 租户 resolve（替代硬编码 4 工具全量同步） */
@ApiTags('resolve')
@Controller('resolve')
export class ResolveController {
  private readonly logger = new Logger(ResolveController.name);

  constructor(private readonly tenancy: TenancyService) {}

  @Post('tools')
  @HttpCode(HttpStatus.OK)
  resolveTools(@Body() body: { orgId?: unknown; projectFeature?: unknown }): { tools: string[] } {
    const orgId = requireString(body.orgId, 'orgId');
    const feature = this.parseFeature(body.projectFeature);
    const tools = this.tenancy.resolveTools(SERVER_TOOL_IDS, feature);
    this.logger.debug(
      `resolve/tools org=${orgId} feature=${JSON.stringify(feature)} -> ${tools.join(',')}`,
    );
    return { tools };
  }

  @Post('rules')
  @HttpCode(HttpStatus.OK)
  resolveRules(
    @Body()
    body: {
      orgId?: unknown;
      projectFeature?: unknown;
      currentVersions?: unknown;
    },
  ): {
    rules: Array<{ ruleId: string; version: string; sha: string | null; source: string }>;
    changed: string[];
  } {
    const orgId = requireString(body.orgId, 'orgId');
    const feature = this.parseFeature(body.projectFeature);
    const currentVersions = this.parseVersions(body.currentVersions);
    const { rules, changed } = this.tenancy.resolveRules(orgId, currentVersions);
    // 画像在服务端只做保守裁剪记录（security 类恒含原则由 rule_scope 维护方保证）；
    // feature 参数本期仅用于审计日志与后续服务端 tag 匹配扩展点。
    this.logger.debug(
      `resolve/rules org=${orgId} feature=${JSON.stringify(feature)} rules=${rules.length} changed=${changed.length}`,
    );
    return { rules: rules.map(toRuleDto), changed };
  }

  @Get('health')
  @HttpCode(HttpStatus.OK)
  health(): { ok: true } {
    return { ok: true };
  }

  private parseFeature(raw: unknown): ScopeProfileLike | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object') throw new BadRequestException('projectFeature 必须为对象');
    const f = raw as Record<string, unknown>;
    return {
      framework: typeof f.framework === 'string' ? f.framework : undefined,
      language: typeof f.language === 'string' ? f.language : undefined,
      features: Array.isArray(f.features) ? f.features.map((x) => String(x)) : undefined,
    };
  }

  private parseVersions(raw: unknown): Record<string, string> | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object') throw new BadRequestException('currentVersions 必须为对象');
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
}

function toRuleDto(r: RuleScopeRow): {
  ruleId: string;
  version: string;
  sha: string | null;
  source: string;
} {
  return { ruleId: r.rule_id, version: r.version, sha: r.content_sha, source: r.source };
}
