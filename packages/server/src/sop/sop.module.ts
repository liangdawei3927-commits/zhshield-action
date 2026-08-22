import { Module } from '@nestjs/common';
import { SopService } from './sop.service';
import { SopVersionController } from './sop-version.controller';
import { SopSyncController } from './sop-sync.controller';
import { ToolRuleLoader } from './tool-rule-loader';
import { ToolRuleController } from './tool-rule.controller';
import { ExperienceController } from './experience.controller';
import { EvolveModule } from '../evolve/evolve.module';

@Module({
  imports: [EvolveModule],
  controllers: [SopVersionController, SopSyncController, ToolRuleController, ExperienceController],
  providers: [SopService, ToolRuleLoader],
  exports: [SopService],
})
export class SopModule {}
