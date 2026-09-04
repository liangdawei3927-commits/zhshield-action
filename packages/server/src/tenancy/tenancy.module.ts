import { Module } from '@nestjs/common';
import { TenancyService } from './tenancy.service';
import { OrgsController, ResolveController } from './tenancy.controller';

/**
 * M3 轻量 Org 多租户模块。
 * 端点：/orgs（组织/项目画像/规则发布）、/resolve/tools、/resolve/rules（T1 核心）。
 * 鉴权沿用全局 LocalOnlyGuard（本地令牌）；云端账号体系为后续增量。
 */
@Module({
  controllers: [OrgsController, ResolveController],
  providers: [TenancyService],
})
export class TenancyModule {}
