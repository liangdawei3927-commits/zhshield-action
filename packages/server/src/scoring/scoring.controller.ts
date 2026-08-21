import { Controller, Get, Param, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ScoringService, type ScoreData } from './scoring.service';

@ApiTags('Scoring')
@Controller('scoring')
export class ScoringController {
  private readonly logger = new Logger(ScoringController.name);

  constructor(private readonly scoringService: ScoringService) {}

  @Get('score/:projectId')
  @ApiOperation({ summary: '获取项目评分' })
  @ApiResponse({ status: 200, description: '返回项目当前评分' })
  getScore(@Param('projectId') projectId: string): { success: boolean; data: ScoreData | null; timestamp: string } {
    this.logger.log(`Score request for project: ${projectId}`);
    const score = this.scoringService.getScore(projectId);
    return {
      success: true,
      data: score ? this.scoringService.toScoreData(score) : null,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('history/:projectId')
  @ApiOperation({ summary: '获取项目评分历史' })
  @ApiResponse({ status: 200, description: '返回项目评分历史记录' })
  getHistory(@Param('projectId') projectId: string): { success: boolean; data: ScoreData[]; timestamp: string } {
    this.logger.log(`Score history request for project: ${projectId}`);
    const history = this.scoringService.getHistory(projectId).map((s) => this.scoringService.toScoreData(s));
    return {
      success: true,
      data: history,
      timestamp: new Date().toISOString(),
    };
  }
}
