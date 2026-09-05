import {
  Controller,
  Get,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ToolRuleFile } from '@zh/kernel';
import { SERVER_TOOL_IDS } from '@zh/shared';
import { ToolRuleStore, type ToolRuleVersion } from './tool-rule-store';

export { SERVER_TOOL_IDS };

@ApiTags('rules')
@Controller('rules')
export class ToolRuleController {
  private readonly logger = new Logger(ToolRuleController.name);

  constructor(private readonly store: ToolRuleStore) {}

  @Get(':tool/version')
  @HttpCode(HttpStatus.OK)
  getVersion(@Param('tool') tool: string): ToolRuleVersion {
    return this.store.getVersion(tool);
  }

  @Get(':tool/download')
  @HttpCode(HttpStatus.OK)
  getRules(@Param('tool') tool: string): ToolRuleFile[] {
    return this.store.getRules(tool);
  }

  @Get(':tool/emergency')
  @HttpCode(HttpStatus.OK)
  getEmergency(@Param('tool') tool: string): ToolRuleFile[] {
    this.logger.warn(
      `Emergency rule pack requested for ${tool}: serving static local pack (identical to regular rules)`,
    );
    return this.store.getRules(tool);
  }
}