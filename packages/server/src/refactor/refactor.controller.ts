import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import type { LanguageCode } from '@zh/i18n';
import { RefactorService } from './refactor.service';
import { RequestLocale } from '../i18n/request-locale';

@ApiTags('Refactor')
@Controller('refactor')
export class RefactorController {
  private readonly logger = new Logger(RefactorController.name);

  constructor(private readonly refactorService: RefactorService) {}

  @Post('scan')
  @ApiOperation({ summary: '扫描代码异味' })
  @ApiBody({ schema: { properties: { projectPath: { type: 'string', description: '项目路径' }, mode: { type: 'string', enum: ['full', 'staged'], description: '扫描模式' } }, required: ['projectPath'] } })
  @ApiResponse({ status: 200, description: '代码异味扫描完成' })
  async scan(
    @Body() body: { projectPath: string; mode?: 'full' | 'staged' },
    @RequestLocale() locale: LanguageCode,
  ) {
    this.logger.log(`Refactor scan request: ${body.projectPath} (mode: ${body.mode ?? 'full'})`);

    const result =
      body.mode === 'staged'
        ? await this.refactorService.scanStaged(body.projectPath, locale)
        : await this.refactorService.scanDirectory(body.projectPath, locale);

    return {
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    };
  }
}
