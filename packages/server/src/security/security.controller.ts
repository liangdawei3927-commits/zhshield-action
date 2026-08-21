import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { SecurityService } from './security.service';

@ApiTags('Security')
@Controller('security')
export class SecurityController {
  private readonly logger = new Logger(SecurityController.name);

  constructor(private readonly securityService: SecurityService) {}

  @Post('scan')
  @ApiOperation({ summary: '执行安全扫描' })
  @ApiBody({ schema: { properties: { projectPath: { type: 'string', description: '项目路径' } }, required: ['projectPath'] } })
  @ApiResponse({ status: 200, description: '安全扫描完成' })
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
