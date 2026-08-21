import {
  Controller,
  Get,
  Param,
  Query,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { SopService } from './sop.service';
import type { DiffQueryDto, EmergencyPullDto } from './dto/version-params.dto';

@ApiTags('SOP')
@Controller('sop')
export class SopSyncController {
  private readonly logger = new Logger(SopSyncController.name);

  constructor(private readonly sopService: SopService) {}

  /**
   * GET /api/v1/sop/diff
   * 下载增量更新（文档 7.4 节 步骤 3）
   * 返回两个版本之间的规则差异
   */
  @Get('diff')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/json')
  @ApiOperation({ summary: '获取增量差异' })
  @ApiResponse({ status: 200, description: '返回两个版本之间的规则差异' })
  async getDiff(@Query() query: DiffQueryDto) {
    try {
      const diff = await this.sopService.computeDiff(query.from, query.to);
      return diff;
    } catch (err) {
      this.logger.error(`Failed to compute diff ${query.from}→${query.to}`, err);
      return {
        version: query.to,
        fromVersion: query.from,
        compatibility: '>=0.1.0',
        added: [],
        removed: [],
        modified: [],
        unchanged: [],
        metadata: { totalRules: 0, diffSize: 0, hash: '' },
      };
    }
  }

  /**
   * GET /api/v1/sop/full/:version
   * 全量同步（首次同步或增量失败时降级）
   * 返回指定版本的完整规则包（brotli 压缩）
   */
  @Get('full/:version')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/octet-stream')
  @Header('Content-Encoding', 'br')
  @ApiOperation({ summary: '获取全量规则包' })
  @ApiParam({ name: 'version', description: '目标版本号' })
  @ApiResponse({ status: 200, description: '返回完整规则包（brotli压缩）' })
  async getFullSync(@Param('version') version: string) {
    try {
      const compressed = await this.sopService.getFullPackage(version);
      return new StreamableFile(compressed);
    } catch (err) {
      this.logger.error(`Failed to get full package for version ${version}`, err);
      throw err;
    }
  }

  /**
   * GET /api/v1/sop/public-key
   * 返回规则包签名公钥（PEM），客户端同步/紧急更新验签使用
   */
  @Get('public-key')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/json')
  @ApiOperation({ summary: '获取签名公钥' })
  @ApiResponse({ status: 200, description: '返回Ed25519签名公钥' })
  async getPublicKey() {
    return {
      algorithm: 'ed25519',
      publicKey: this.sopService.getPublicKey(),
    };
  }

  /**
   * GET /api/v1/sop/emergency
   * 紧急更新（文档 7.5 节 触发方式 3）
   * 获取最新的紧急安全规则（Ed25519 签名包）
   */
  @Get('emergency')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/json')
  @ApiOperation({ summary: '获取紧急安全规则' })
  @ApiResponse({ status: 200, description: '返回紧急安全规则包' })
  async getEmergency(@Query() _query: EmergencyPullDto) {
    try {
      return await this.sopService.getEmergencyRules();
    } catch (err) {
      this.logger.error('Failed to get emergency rules', err);
      return { version: 'emergency', rules: [], timestamp: new Date().toISOString() };
    }
  }
}
