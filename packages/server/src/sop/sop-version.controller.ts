import { Controller, Get, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SopService } from './sop.service';
import type { VersionQueryDto } from './dto/version-params.dto';

@ApiTags('sop')
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
