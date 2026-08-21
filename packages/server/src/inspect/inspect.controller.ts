import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { InspectService } from './inspect.service';

@ApiTags('Inspect')
@Controller('inspect')
export class InspectController {
  private readonly logger = new Logger(InspectController.name);

  constructor(private readonly inspectService: InspectService) {}

  @Post('scan')
  @ApiOperation({ summary: '执行质量扫描' })
  @ApiBody({ schema: { properties: { projectPath: { type: 'string', description: '项目路径' } }, required: ['projectPath'] } })
  @ApiResponse({ status: 200, description: '质量扫描完成' })
  async scan(@Body() body: { projectPath: string }) {
    this.logger.log(`Inspect scan request: ${body.projectPath}`);
    const result = await this.inspectService.runScan(body.projectPath);
    return {
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    };
  }
}
