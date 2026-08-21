import { Controller, Post, Body, Logger } from '@nestjs/common';
import { GuardService } from './guard.service';

@Controller('guard')
export class GuardController {
  private readonly logger = new Logger(GuardController.name);

  constructor(private readonly guardService: GuardService) {}

  @Post('check')
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
