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
import type { ToolPackageRow } from '@zh/db';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminService } from './admin.service';
import { Public } from '../auth/local-only.guard';

const TOOL_STATUSES = new Set(['active', 'deprecated', 'disabled']);

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

/** 解析工具包请求体：files 必须为 [{filename, content}] 数组 */
function parseToolBody(body: Record<string, unknown>): {
  toolId: string;
  files: Array<{ filename: string; content: string }>;
  languages?: string[];
  frameworks?: string[];
  description?: string;
  status?: string;
} {
  const toolId = requireString(body.toolId, 'toolId');
  if (!Array.isArray(body.files) || body.files.length === 0) {
    throw new BadRequestException('字段 files 必须为非空数组');
  }
  const files = body.files.map((f, i) => {
    if (typeof f !== 'object' || f === null) {
      throw new BadRequestException(`files[${i}] 必须为对象`);
    }
    const entry = f as Record<string, unknown>;
    return {
      filename: requireString(entry.filename, `files[${i}].filename`),
      content: requireString(entry.content, `files[${i}].content`),
    };
  });
  const status = optionalString(body.status, 'status');
  if (status !== undefined && !TOOL_STATUSES.has(status)) {
    throw new BadRequestException(`字段 status 取值非法: ${status}`);
  }
  return {
    toolId,
    files,
    languages: parseStringArray(body.languages, 'languages'),
    frameworks: parseStringArray(body.frameworks, 'frameworks'),
    description: optionalString(body.description, 'description'),
    status,
  };
}

/**
 * AdminToolsController — C4 管理后台工具包接口（蓝图 §3.1）
 * 鉴权：AdminAuthGuard（ZH_ADMIN_TOKEN Bearer）；全局 LocalOnlyGuard 已放行（@Public）。
 */
@ApiTags('admin')
@Controller('admin/tools')
@Public()
@UseGuards(AdminAuthGuard)
export class AdminToolsController {
  constructor(private readonly admin: AdminService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createTool(@Body() body: Record<string, unknown>): Promise<{ toolId: string; created: true }> {
    const { toolId } = await this.admin.saveToolPackage(parseToolBody(body));
    return { toolId, created: true };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  listTools(): ToolPackageRow[] {
    return this.admin.listTools();
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  async updateTool(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ toolId: string; created: false }> {
    const { toolId } = await this.admin.saveToolPackage({ ...parseToolBody(body), toolId: id });
    return { toolId, created: false };
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  publishTool(@Param('id') id: string): { ok: true } {
    this.admin.publishTool(id);
    return { ok: true };
  }

  @Post(':id/rollback')
  @HttpCode(HttpStatus.OK)
  rollbackTool(
    @Param('id') id: string,
    @Body() body: { version?: unknown },
  ): { ok: true } {
    this.admin.rollbackTool(id, requireString(body.version, 'version'));
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteTool(@Param('id') id: string): { ok: true } {
    this.admin.deleteTool(id);
    return { ok: true };
  }
}