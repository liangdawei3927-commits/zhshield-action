import { Controller, Post, Get, Param, Query, Body, HttpCode, HttpStatus, UseGuards, Logger } from '@nestjs/common';
import { SentinelService } from './sentinel.service';
import { SentinelWebhookGuard } from './sentinel.guard';
import type { SentinelEvent, AlertPayload } from '@zh/sentinel';

@Controller('system/sentinel')
export class SentinelController {
  private readonly logger = new Logger(SentinelController.name);

  constructor(private readonly sentinelService: SentinelService) {}

  // ── Alertmanager Webhook ──────────────────────────────────

  @Post('alertmanager/webhook')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SentinelWebhookGuard)
  handleWebhook(@Body() payload: AlertPayload): { accepted: boolean; eventId?: string; reason?: string } {
    return this.sentinelService.processWebhook('', payload);
  }

  // ── Event Queries ─────────────────────────────────────────

  @Get('event-center')
  listEvents(
    @Query('status') status?: string,
    @Query('severity') severity?: string,
  ): SentinelEvent[] {
    return this.sentinelService.listEvents({ status, severity });
  }

  @Get('event-center/:id')
  getEvent(@Param('id') id: string): SentinelEvent | undefined {
    return this.sentinelService.getEvent(id);
  }

  // ── Management APIs ───────────────────────────────────────

  @Post('file-monitor/start')
  @HttpCode(HttpStatus.OK)
  startFileMonitor(
    @Body() body: { projectId: string; watchPaths: string[] },
  ): { ok: boolean } {
    this.sentinelService.startFileMonitor(body.projectId, body.watchPaths);
    return { ok: true };
  }

  @Post('process-monitor/start')
  @HttpCode(HttpStatus.OK)
  startProcessMonitor(
    @Body() body: { projectId: string; command: string; cwd: string },
  ): { ok: boolean } {
    this.sentinelService.startProcessMonitor(body.projectId, body.command, body.cwd);
    return { ok: true };
  }

  @Post('log-collector/start')
  @HttpCode(HttpStatus.OK)
  startLogCollector(
    @Body() body: { projectId: string; logPaths: string[] },
  ): { ok: boolean } {
    this.sentinelService.startLogCollector(body.projectId, body.logPaths);
    return { ok: true };
  }
}
