import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InspectService } from './inspect.service';

@ApiTags('inspect')
@Controller('inspect')
export class InspectController {
  private readonly logger = new Logger(InspectController.name);

  constructor(private readonly inspectService: InspectService) {}

  @Post('scan')
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
