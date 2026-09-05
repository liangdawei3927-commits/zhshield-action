import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { RuleContentRow } from '@zh/db';
import type { SopRule } from '@zh/kernel';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminService } from './admin.service';
import { Public } from '../auth/local-only.guard';

const DOMAINS = new Set(['guard', 'inspect', 'security', 'sentinel', 'evolve', 'refactor']);
const ACTIONS = new Set(['scan', 'block', 'score', 'alert', 'suggest', 'calibrate']);
const SOURCES = new Set(['external', 'internal', 'community', 'official']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info', 'error']);
const EXECUTION_MODES = new Set(['sync', 'async', 'periodic', 'event']);
const RULE_STATUSES = new Set(['draft', 'trial', 'active', 'deprecated', 'disabled']);

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

function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException(`字段 ${field} 必须为字符串数组`);
  return value.map((v) => String(v));
}

function requireEnum(value: unknown, field: string, allowed: Set<string>): string {
  const s = requireString(value, field);
  if (!allowed.has(s)) {
    throw new BadRequestException(`字段 ${field} 取值非法: ${s}`);
  }
  return s;
}

/** 解析规则请求体为 SopRule；缺省字段按蓝图 §3.1 默认值补齐 */
function parseRuleBody(body: Record<string, unknown>): SopRule {
  const id = requireString(body.id, 'id');
  const name = requireString(body.name, 'name');
  const domain = requireEnum(body.domain, 'domain', DOMAINS) as SopRule['domain'];
  const action = requireEnum(body.action, 'action', ACTIONS) as SopRule['action'];
  const source = requireEnum(body.source, 'source', SOURCES) as SopRule['source'];
  const severity = requireEnum(body.severity, 'severity', SEVERITIES) as SopRule['severity'];
  const executionMode = requireEnum(
    body.executionMode ?? 'async',
    'executionMode',
    EXECUTION_MODES,
  ) as SopRule['executionMode'];
  const status = requireEnum(body.status ?? 'draft', 'status', RULE_STATUSES) as SopRule['status'];
  if (body.content === undefined || body.content === null || typeof body.content !== 'object') {
    throw new BadRequestException('字段 content 必须为对象');
  }
  const serves = body.serves as Record<string, unknown> | undefined;
  return {
    id,
    name,
    domain,
    action,
    source,
    description: optionalString(body.description, 'description') ?? '',
    status,
    executionMode,
    severity,
    applicableEngines: parseStringArray(body.applicableEngines, 'applicableEngines'),
    content: body.content as Record<string, unknown>,
    serves: serves
      ? { languages: parseStringArray(serves.languages, 'serves.languages') }
      : undefined,
    tags: parseStringArray(body.tags, 'tags'),
    falsePositiveCount: Number(body.falsePositiveCount ?? 0),
    truePositiveCount: Number(body.truePositiveCount ?? 0),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * AdminRulesController — C4 管理后台规则接口（蓝图 §3.1）
 * 鉴权：AdminAuthGuard（ZH_ADMIN_TOKEN Bearer）；全局 LocalOnlyGuard 已放行（@Public）。
 */
@ApiTags('admin')
@Controller('admin/rules')
@Public()
@UseGuards(AdminAuthGuard)
export class AdminRulesController {
  constructor(private readonly admin: AdminService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createRule(@Body() body: Record<string, unknown>): Promise<{ ruleId: string; created: true }> {
    const { ruleId } = await this.admin.saveRule(parseRuleBody(body));
    return { ruleId, created: true };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  listRules(): RuleContentRow[] {
    return this.admin.listRules();
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  getRule(@Param('id') id: string): RuleContentRow {
    return this.admin.getRule(id);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  async updateRule(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ ruleId: string; created: false }> {
    const rule = parseRuleBody({ ...body, id });
    const { ruleId } = await this.admin.saveRule(rule);
    return { ruleId, created: false };
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  publishRule(@Param('id') id: string): { ok: true } {
    this.admin.publishRule(id);
    return { ok: true };
  }

  @Post(':id/rollback')
  @HttpCode(HttpStatus.OK)
  rollbackRule(
    @Param('id') id: string,
    @Body() body: { version?: unknown },
  ): { ok: true } {
    this.admin.rollbackRule(id, requireString(body.version, 'version'));
    return { ok: true };
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @Param('id') id: string,
    @Body() body: { status?: unknown },
  ): { ok: true } {
    this.admin.setRuleStatus(id, requireString(body.status, 'status'));
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteRule(@Param('id') id: string): { ok: true } {
    this.admin.deleteRule(id);
    return { ok: true };
  }
}