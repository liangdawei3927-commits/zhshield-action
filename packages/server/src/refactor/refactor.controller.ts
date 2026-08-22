import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RefactorService } from './refactor.service';

@ApiTags('refactor')
@Controller('refactor')
export class RefactorController {
  private readonly logger = new Logger(RefactorController.name);

  constructor(private readonly refactorService: RefactorService) {}

  @Post('scan')
  async scan(
    @Body() body: { projectPath: string; mode?: 'full' | 'staged' },
  ) {
    this.logger.log(`Refactor scan request: ${body.projectPath} (mode: ${body.mode ?? 'full'})`);

    const result =
      body.mode === 'staged'
        ? await this.refactorService.scanStaged(body.projectPath)
        : await this.refactorService.scanDirectory(body.projectPath);

    return {
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    };
  }
}
