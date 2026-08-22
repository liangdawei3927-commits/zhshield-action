import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PipelineService } from './pipeline.service';
import type { PipelineReport } from '@zh/pipeline';

@ApiTags('pipeline')
@Controller('pipeline')
export class PipelineController {
  private readonly logger = new Logger(PipelineController.name);

  constructor(private readonly pipelineService: PipelineService) {}

  @Post('run')
  async run(
    @Body() body: { projectPath: string; dryRun?: boolean; sop?: boolean },
  ) {
    this.logger.log(`Pipeline run request: ${body.projectPath}`);

    const result = await this.pipelineService.runPipeline(body);

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
