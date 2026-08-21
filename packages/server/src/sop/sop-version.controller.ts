import { Controller, Get, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SopService } from './sop.service';
import type { VersionQueryDto } from './dto/version-params.dto';

@ApiTags('SOP')
@Controller('sop')
export class SopVersionController {
  constructor(private readonly sopService: SopService) {}

  /**
   * GET /api/v1/sop/version
   * 版本检查接口（文档 7.4 节 步骤 1）
   * 返回当前云端最新版本号
   */
  @Get('version')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '获取SOP版本信息' })
  @ApiResponse({ status: 200, description: '返回当前云端最新版本号' })
  async getVersion(@Query() _query: VersionQueryDto) {
    const version = await this.sopService.getCurrentVersion();
    return {
      version: version.version,
      knowledge: version.knowledge,
      experience: version.experience,
      malware: version.malware,
      hash: version.hash,
      publishedAt: version.publishedAt,
    };
  }
}
