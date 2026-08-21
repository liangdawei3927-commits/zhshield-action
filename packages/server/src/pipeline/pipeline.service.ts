import { Injectable, Logger } from '@nestjs/common';
import { PipelineRunner } from '@zh/pipeline';
import type { PipelineReport } from '@zh/pipeline';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  async runPipeline(params: {
    projectPath: string;
    dryRun?: boolean;
    sop?: boolean;
  }): Promise<PipelineReport> {
    this.logger.log(
      `Running pipeline on: ${params.projectPath} (sop=${!!params.sop}, dryRun=${!!params.dryRun})`,
    );

    const runner = new PipelineRunner(params.projectPath);
    try {
      await runner.loadSopRules();
      const report = params.sop
        ? await runner.runSopDrivenPipeline({ guardContext: { dryRun: params.dryRun } })
        : await runner.runFullPipeline({ dryRun: params.dryRun });
      return report;
    } finally {
      await runner.destroy();
    }
  }
}
