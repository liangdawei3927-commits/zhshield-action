import { Injectable, Logger } from '@nestjs/common';
import { PipelineRunner } from '@zh/pipeline';
import type { PipelineReport } from '@zh/pipeline';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import { ScoringService } from '../scoring/scoring.service';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(private readonly scoringService: ScoringService) {}

  async runPipeline(
    params: {
      projectPath: string;
      dryRun?: boolean;
      sop?: boolean;
    },
    locale?: LanguageCode,
  ): Promise<PipelineReport> {
    this.logger.log(
      `Running pipeline on: ${params.projectPath} (sop=${!!params.sop}, dryRun=${!!params.dryRun})`,
    );

    const runner = new PipelineRunner(params.projectPath);
    try {
      await runner.loadSopRules(locale);
      const report = params.sop
        ? await runner.runSopDrivenPipeline({ guardContext: { dryRun: params.dryRun } }, locale)
        : await runner.runFullPipeline({ dryRun: params.dryRun }, locale);
      this.recordScoreIfApplicable(params.projectPath, report, !!params.dryRun, locale);
      return report;
    } finally {
      await runner.destroy();
    }
  }

  /** 体检（非 dryRun）且 guard/inspect 均为结构化报告时，记录健康评分 */
  private recordScoreIfApplicable(
    projectPath: string,
    report: PipelineReport,
    dryRun: boolean,
    locale?: LanguageCode,
  ): void {
    if (dryRun) return;
    const guard = report.guard;
    const inspect = report.inspect;
    if (!guard || !inspect) return;
    if (!('results' in guard) || !('issues' in inspect)) return;

    try {
      this.scoringService.recordPipelineScore(
        projectPath,
        guard as GuardReport,
        inspect as InspectionReport,
        locale,
      );
    } catch (err) {
      this.logger.warn(
        translate('server.pipeline.scoreRecordFailed', locale ?? DEFAULT_LANGUAGE, {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
