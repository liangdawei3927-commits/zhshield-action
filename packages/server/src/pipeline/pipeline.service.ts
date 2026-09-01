import { Injectable, Logger } from '@nestjs/common';
import { PipelineRunner } from '@zh/pipeline';
import type { PipelineReport } from '@zh/pipeline';
import { ScoringService } from '../scoring/scoring.service';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(private readonly scoringService: ScoringService) {}

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
      // 体检完成后立即计算并持久化健康分，保证 GET /scoring/score/:projectId 有值
      this.scoringService.recordPipelineScore(params.projectPath, report);
      return report;
    } finally {
      await runner.destroy();
    }
  }
}
