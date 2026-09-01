import { Controller, Get, Post, Body, Param, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EvolveService } from './evolve.service';
import type { ExperienceType, RuleState } from '@zh/evolve';

@ApiTags('evolve')
@Controller('evolve')
export class EvolveController {
  private readonly logger = new Logger(EvolveController.name);

  constructor(private readonly evolveService: EvolveService) {}

  @Get('suggestions/:projectId')
  async getSuggestions(@Param('projectId') projectId: string) {
    this.logger.log(`Suggestions request for project: ${projectId}`);
    const data = await this.evolveService.getSuggestions(projectId);
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Post('experience')
  async recordExperience(
    @Body()
    body: {
      projectId: string;
      ruleId: string;
      type: string;
      pattern: string;
      message: string;
      feedback: string;
      source?: string;
      confidence?: number;
    },
  ) {
    this.logger.log(`Record experience for rule: ${body.ruleId}`);
    const result = await this.evolveService.recordExperience({
      projectId: body.projectId,
      ruleId: body.ruleId,
      type: body.type as ExperienceType,
      pattern: body.pattern,
      message: body.message,
      feedback: body.feedback,
      source: (body.source as 'user' | 'auto') ?? 'user',
      confidence: body.confidence ?? 1.0,
      verified: false,
      issueId: undefined,
    });
    return { success: true, data: result, timestamp: new Date().toISOString() };
  }

  @Get('experiences/:projectId')
  async listExperiences(@Param('projectId') projectId: string) {
    const data = await this.evolveService.listExperiences(projectId);
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Post('weights/adjust')
  async autoAdjustWeights() {
    const data = await this.evolveService.autoAdjustWeights();
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Get('weights')
  async getRuleWeights() {
    const data = await this.evolveService.getRuleWeights();
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Get('weights/:ruleId')
  async getRuleWeight(@Param('ruleId') ruleId: string) {
    const data = await this.evolveService.getRuleWeight(ruleId);
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Post('rule-state')
  async changeRuleState(
    @Body() body: { ruleId: string; state: string; reason: string; changedBy: string },
  ) {
    const data = await this.evolveService.changeRuleState(
      body.ruleId,
      body.state as RuleState,
      body.reason,
      body.changedBy,
    );
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Get('rule-state/:ruleId')
  async getRuleState(@Param('ruleId') ruleId: string) {
    const data = await this.evolveService.getRuleState(ruleId);
    return { success: true, data, timestamp: new Date().toISOString() };
  }
}
