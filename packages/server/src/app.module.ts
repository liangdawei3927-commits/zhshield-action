import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { HealthController } from './health.controller';
import { csrfProtection } from './security/csrf-protection.middleware';
import { SopModule } from './sop/sop.module';
import { SentinelModule } from './sentinel/sentinel.module';
import { GuardModule } from './guard/guard.module';
import { InspectModule } from './inspect/inspect.module';
import { SecurityModule } from './security/security.module';
import { ScoringModule } from './scoring/scoring.module';
import { RefactorModule } from './refactor/refactor.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { EvolveModule } from './evolve/evolve.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AdminModule } from './admin/admin.module';
import { LocalOnlyGuard } from './auth/local-only.guard';

@Module({
  imports: [
    SopModule,
    SentinelModule,
    GuardModule,
    InspectModule,
    SecurityModule,
    ScoringModule,
    RefactorModule,
    PipelineModule,
    EvolveModule,
    TenancyModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: LocalOnlyGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 双提交 Cookie CSRF 防护：全路由挂载，中间件内部按会话/凭据放行规则缩小生效面
    consumer.apply(csrfProtection).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
