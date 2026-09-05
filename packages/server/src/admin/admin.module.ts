import { Module } from '@nestjs/common';
import { SopModule } from '../sop/sop.module';
import { SopContentAdminRepository } from '../sop/sop-content-admin.repository';
import { AdminPagesController } from './admin-pages.controller';
import { AdminRulesController } from './admin-rules.controller';
import { AdminToolsController } from './admin-tools.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [SopModule],
  controllers: [AdminRulesController, AdminToolsController, AdminPagesController],
  providers: [AdminService, SopContentAdminRepository],
})
export class AdminModule {}