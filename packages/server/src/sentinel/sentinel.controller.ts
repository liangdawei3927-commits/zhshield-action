import { Controller, Post, Get, Param, Query, Body, HttpCode, HttpStatus, UseGuards, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery } from '@nestjs/swagger';
import { SentinelService } from './sentinel.service';
import { SentinelWebhookGuard } from './sentinel.guard';
import type { SentinelEvent, AlertPayload } from '@zh/sentinel';

@ApiTags('Sentinel')
@Controller('system/sentinel')
export class SentinelController {
  private readonly logger = new Logger(SentinelController.name);

  constructor(private readonly sentinelService: SentinelService) {}

  // ── Alertmanager Webhook ──────────────────────────────────

  @Post('alertmanager/webhook')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SentinelWebhookGuard)
  @ApiOperation({ summary: '接收Alertmanager Webhook告警' })
  @ApiBody({ schema: { properties: { alerts: { type: 'array', items: { type: 'object' }, description: '告警列表' } } } })
  @ApiResponse({ status: 200, description: 'Webhook告警已接收' })
  handleWebhook(@Body() payload: AlertPayload): { accepted: boolean; eventId?: string; reason?: string } {
    return this.sentinelService.processWebhook('', payload);
  }

  // ── Event Queries ─────────────────────────────────────────

  @Get('event-center')
  @ApiOperation({ summary: '查询告警事件列表' })
  @ApiQuery({ name: 'status', required: false, description: '按状态筛选' })
  @ApiQuery({ name: 'severity', required: false, description: '按严重级别筛选' })
  @ApiResponse({ status: 200, description: '返回告警事件列表' })
  listEvents(
    @Query('status') status?: string,
    @Query('severity') severity?: string,
  ): SentinelEvent[] {
    return this.sentinelService.listEvents({ status, severity });
  }

  @Get('event-center/:id')
  @ApiOperation({ summary: '获取单个告警事件详情' })
  @ApiResponse({ status: 200, description: '返回告警事件详情' })
  getEvent(@Param('id') id: string): SentinelEvent | undefined {
    return this.sentinelService.getEvent(id);
  }

  // ── Management APIs ───────────────────────────────────────

  @Post('file-monitor/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '启动文件监控' })
  @ApiBody({ schema: { properties: { projectId: { type: 'string', description: '项目ID' }, watchPaths: { type: 'array', items: { type: 'string' }, description: '监控路径列表' } }, required: ['projectId', 'watchPaths'] } })
  @ApiResponse({ status: 200, description: '文件监控已启动' })
  startFileMonitor(
    @Body() body: { projectId: string; watchPaths: string[] },
  ): { ok: boolean } {
    this.sentinelService.startFileMonitor(body.projectId, body.watchPaths);
    return { ok: true };
  }

  @Post('process-monitor/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '启动进程监控' })
  @ApiBody({ schema: { properties: { projectId: { type: 'string', description: '项目ID' }, command: { type: 'string', description: '监控命令' }, cwd: { type: 'string', description: '工作目录' } }, required: ['projectId', 'command', 'cwd'] } })
  @ApiResponse({ status: 200, description: '进程监控已启动' })
  startProcessMonitor(
    @Body() body: { projectId: string; command: string; cwd: string },
  ): { ok: boolean } {
    this.sentinelService.startProcessMonitor(body.projectId, body.command, body.cwd);
    return { ok: true };
  }

  @Post('log-collector/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '启动日志收集器' })
  @ApiBody({ schema: { properties: { projectId: { type: 'string', description: '项目ID' }, logPaths: { type: 'array', items: { type: 'string' }, description: '日志路径列表' } }, required: ['projectId', 'logPaths'] } })
  @ApiResponse({ status: 200, description: '日志收集器已启动' })
  startLogCollector(
    @Body() body: { projectId: string; logPaths: string[] },
  ): { ok: boolean } {
    this.sentinelService.startLogCollector(body.projectId, body.logPaths);
    return { ok: true };
  }
}
