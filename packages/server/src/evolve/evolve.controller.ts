import { Controller, Get, Post, Body, Param, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { EvolveService } from './evolve.service';
import type { ExperienceType, RuleState } from '@zh/evolve';

@ApiTags('Evolve')
@Controller('evolve')
export class EvolveController {
  private readonly logger = new Logger(EvolveController.name);

  constructor(private readonly evolveService: EvolveService) {}

  @Get('suggestions/:projectId')
  @ApiOperation({ summary: '获取项目进化建议' })
  @ApiResponse({ status: 200, description: '返回进化建议列表' })
  async getSuggestions(@Param('projectId') projectId: string) {
    this.logger.log(`Suggestions request for project: ${projectId}`);
    const data = await this.evolveService.getSuggestions(projectId);
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Post('experience')
  @ApiOperation({ summary: '记录经验反馈' })
  @ApiBody({ schema: { properties: { projectId: { type: 'string', description: '项目ID' }, ruleId: { type: 'string', description: '规则ID' }, type: { type: 'string', description: '经验类型' }, pattern: { type: 'string', description: '代码模式' }, message: { type: 'string', description: '反馈消息' }, feedback: { type: 'string', description: '反馈内容' }, source: { type: 'string', description: '来源' }, confidence: { type: 'number', description: '置信度' } }, required: ['projectId', 'ruleId', 'type', 'pattern', 'message', 'feedback'] } })
  @ApiResponse({ status: 200, description: '经验记录成功' })
  async recordExperience(
    @Body() body: { projectId: string; ruleId: string; type: string; pattern: string; message: string; feedback: string; source?: string; confidence?: number },
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
  @ApiOperation({ summary: '查询项目经验记录' })
  @ApiResponse({ status: 200, description: '返回经验记录列表' })
  async listExperiences(@Param('projectId') projectId: string) {
    const data = await this.evolveService.listExperiences(projectId);
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Post('weights/adjust')
  @ApiOperation({ summary: '自动调整规则权重' })
  @ApiResponse({ status: 200, description: '权重调整完成' })
  async autoAdjustWeights() {
    const data = await this.evolveService.autoAdjustWeights();
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Get('weights')
  @ApiOperation({ summary: '获取所有规则权重' })
  @ApiResponse({ status: 200, description: '返回规则权重列表' })
  async getRuleWeights() {
    const data = await this.evolveService.getRuleWeights();
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Get('weights/:ruleId')
  @ApiOperation({ summary: '获取单条规则权重' })
  @ApiResponse({ status: 200, description: '返回规则权重详情' })
  async getRuleWeight(@Param('ruleId') ruleId: string) {
    const data = await this.evolveService.getRuleWeight(ruleId);
    return { success: true, data, timestamp: new Date().toISOString() };
  }

  @Post('rule-state')
  @ApiOperation({ summary: '变更规则状态' })
  @ApiBody({ schema: { properties: { ruleId: { type: 'string', description: '规则ID' }, state: { type: 'string', description: '目标状态' }, reason: { type: 'string', description: '变更原因' }, changedBy: { type: 'string', description: '变更人' } }, required: ['ruleId', 'state', 'reason', 'changedBy'] } })
  @ApiResponse({ status: 200, description: '规则状态已变更' })
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
  @ApiOperation({ summary: '查询规则状态' })
  @ApiResponse({ status: 200, description: '返回规则当前状态' })
  async getRuleState(@Param('ruleId') ruleId: string) {
    const data = await this.evolveService.getRuleState(ruleId);
    return { success: true, data, timestamp: new Date().toISOString() };
  }
}
