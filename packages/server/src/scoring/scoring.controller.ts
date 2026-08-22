import { Controller, Get, Param, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ScoringService } from './scoring.service';

@ApiTags('scoring')
@Controller('scoring')
export class ScoringController {
  private readonly logger = new Logger(ScoringController.name);

  constructor(private readonly scoringService: ScoringService) {}

  @Get('score/:projectId')
  getScore(@Param('projectId') projectId: string) {
    this.logger.log(`Score request for project: ${projectId}`);
    const score = this.scoringService.getScore(projectId);
    return {
      success: true,
      data: score,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('history/:projectId')
  getHistory(@Param('projectId') projectId: string) {
    this.logger.log(`Score history request for project: ${projectId}`);
    const history = this.scoringService.getHistory(projectId);
    return {
      success: true,
      data: history,
      timestamp: new Date().toISOString(),
    };
  }
}
