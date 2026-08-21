import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { GuardService } from './guard.service';

@ApiTags('Guard')
@Controller('guard')
export class GuardController {
  private readonly logger = new Logger(GuardController.name);

  constructor(private readonly guardService: GuardService) {}

  @Post('check')
  @ApiOperation({ summary: '执行门禁检查' })
  @ApiBody({ schema: { properties: { projectPath: { type: 'string', description: '项目路径' }, dryRun: { type: 'boolean', description: '试运行模式' } }, required: ['projectPath'] } })
  @ApiResponse({ status: 200, description: '门禁检查完成' })
  async check(
    @Body() body: { projectPath: string; dryRun?: boolean },
  ) {
    this.logger.log(`Guard check request: ${body.projectPath}`);
    const result = await this.guardService.runCheck(body.projectPath, { dryRun: body.dryRun });
    return {
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    };
  }
}
