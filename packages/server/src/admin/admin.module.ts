import { Module } from '@nestjs/common';
import { SopModule } from '../sop/sop.module';
import { SopRuleAdminRepository } from '../sop/sop-content-admin.repository';
import { SopToolAdminRepository } from '../sop/sop-tool-admin.repository';
import { AdminPagesController } from './admin-pages.controller';
import { AdminRulesController } from './admin-rules.controller';
import { AdminToolsController } from './admin-tools.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [SopModule],
  controllers: [AdminRulesController, AdminToolsController, AdminPagesController],
  providers: [AdminService, SopRuleAdminRepository, SopToolAdminRepository],
})
export class AdminModule {}
