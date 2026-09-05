import { Module } from '@nestjs/common';
import { SopService } from './sop.service';
import { SopVersionController } from './sop-version.controller';
import { SopSyncController } from './sop-sync.controller';
import { ToolRuleLoader } from './tool-rule-loader';
import { ToolRuleController } from './tool-rule.controller';
import { ToolRuleStore } from './tool-rule-store';
import { ExperienceController } from './experience.controller';
import { EvolveModule } from '../evolve/evolve.module';
import { SopContentRepository } from './sop-content.repository';

@Module({
  imports: [EvolveModule],
  controllers: [SopVersionController, SopSyncController, ToolRuleController, ExperienceController],
  providers: [SopService, ToolRuleLoader, SopContentRepository, ToolRuleStore],
  exports: [SopService, ToolRuleStore, SopContentRepository],
})
export class SopModule {}
