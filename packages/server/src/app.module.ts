import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { SopModule } from './sop/sop.module';
import { SentinelModule } from './sentinel/sentinel.module';
import { GuardModule } from './guard/guard.module';
import { InspectModule } from './inspect/inspect.module';
import { SecurityModule } from './security/security.module';
import { ScoringModule } from './scoring/scoring.module';
import { RefactorModule } from './refactor/refactor.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { EvolveModule } from './evolve/evolve.module';

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
  ],
  controllers: [HealthController],
})
export class AppModule {}
