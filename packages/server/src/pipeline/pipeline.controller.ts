import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import type { LanguageCode } from '@zh/i18n';
import { PipelineService } from './pipeline.service';
import type { PipelineReport } from '@zh/pipeline';
import { RequestLocale } from '../i18n/request-locale';

@ApiTags('Pipeline')
@Controller('pipeline')
export class PipelineController {
  private readonly logger = new Logger(PipelineController.name);

  constructor(private readonly pipelineService: PipelineService) {}

  @Post('run')
  @ApiOperation({ summary: '执行治理流水线' })
  @ApiBody({ schema: { properties: { projectPath: { type: 'string', description: '项目路径' }, dryRun: { type: 'boolean', description: '试运行模式' }, sop: { type: 'boolean', description: '启用SOP规则' } }, required: ['projectPath'] } })
  @ApiResponse({ status: 200, description: '流水线执行完成' })
  async run(
    @Body() body: { projectPath: string; dryRun?: boolean; sop?: boolean },
    @RequestLocale() locale: LanguageCode,
  ) {
    this.logger.log(`Pipeline run request: ${body.projectPath}`);

    const result = await this.pipelineService.runPipeline(body, locale);

    const summary = this.buildSummary(result);
    return this.buildResponse(result, summary);
  }

  private buildSummary(result: PipelineReport): Record<string, unknown> {
    const summary: Record<string, unknown> = { refactorTotalSmells: result.refactor?.totalSmells ?? null };

    if (result.guard && 'ok' in result.guard) {
      summary.guardPassed = (result.guard as unknown as { ok: boolean | undefined }).ok;
    } else if (result.guard && 'passed' in result.guard) {
      summary.guardPassed = (result.guard as unknown as { passed: number }).passed > 0;
    } else {
      summary.guardPassed = null;
    }

    if (result.inspect && 'passed' in result.inspect) {
      summary.inspectPassed = (result.inspect as unknown as { passed: number }).passed > 0;
    } else {
      summary.inspectPassed = null;
    }

    return summary;
  }

  private buildResponse(result: PipelineReport, summary: Record<string, unknown>) {
    return {
      success: true,
      data: {
        passed: result.passed,
        stage: result.stage,
        timestamp: result.timestamp,
        summary,
        error: result.error ?? null,
      },
      raw: result,
      timestamp: new Date().toISOString(),
    };
  }
}
