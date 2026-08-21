import { Controller, Post, Body, Logger } from '@nestjs/common';
import { SecurityService } from './security.service';

@Controller('security')
export class SecurityController {
  private readonly logger = new Logger(SecurityController.name);

  constructor(private readonly securityService: SecurityService) {}

  @Post('scan')
  async scan(@Body() body: { projectPath: string }) {
    this.logger.log(`Security scan request: ${body.projectPath}`);
    const result = await this.securityService.runScan(body.projectPath);
    return {
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    };
  }
}
