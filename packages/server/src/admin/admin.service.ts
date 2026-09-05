import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RuleContentRow, ToolPackageRow } from '@zh/db';
import type { SopRule } from '@zh/kernel';
import { AdminError, SopContentAdminRepository } from '../sop/sop-content-admin.repository';
import { SopService } from '../sop/sop.service';
import { ToolRuleStore } from '../sop/tool-rule-store';

/** 仓库层 AdminError → Nest HTTP 异常（kind: validation→400, not_found→404, unavailable→503） */
function translateAdminError(err: AdminError): never {
  switch (err.kind) {
    case 'validation':
      throw new BadRequestException(err.message);
    case 'not_found':
      throw new NotFoundException(err.message);
    case 'unavailable':
      throw new ServiceUnavailableException(err.message);
  }
}

/**
 * AdminService — C4 管理接口业务编排
 *
 * 规则写路径完成后 await SopService.reloadFromRepository()（registry 立即生效），
 * 工具包写路径完成后 ToolRuleStore.reloadFromRepository()（/version /download 立即生效）。
 * 仓库层抛 AdminError，此处统一翻译为 HTTP 异常；控制器只做参数解析与转发。
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly adminRepo: SopContentAdminRepository,
    private readonly sopService: SopService,
    private readonly toolRuleStore: ToolRuleStore,
  ) {}

  // ─── 规则 ──────────────────────────────────────────────────

  async saveRule(rule: SopRule): Promise<{ ruleId: string; created: boolean }> {
    try {
      const result = this.adminRepo.saveRule(rule);
      await this.sopService.reloadFromRepository();
      return result;
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }

  async publishRule(ruleId: string): Promise<void> {
    try {
      this.adminRepo.publishRule(ruleId);
      await this.sopService.reloadFromRepository();
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }

  async rollbackRule(ruleId: string, version: string): Promise<void> {
    try {
      this.adminRepo.rollbackRule(ruleId, version);
      await this.sopService.reloadFromRepository();
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }

  async setRuleStatus(ruleId: string, status: string): Promise<void> {
    try {
      this.adminRepo.setRuleStatus(ruleId, status);
      await this.sopService.reloadFromRepository();
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }

  async deleteRule(ruleId: string): Promise<void> {
    try {
      this.adminRepo.deleteRule(ruleId);
      await this.sopService.reloadFromRepository();
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }

  listRules(): RuleContentRow[] {
    return this.adminRepo.listRules();
  }

  getRule(ruleId: string): RuleContentRow {
    try {
      return this.adminRepo.getRule(ruleId);
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }

  listRuleVersions(ruleId: string): Array<{ version: string; releasedAt: string }> {
    return this.adminRepo.listRuleVersions(ruleId);
  }

  // ─── 工具包 ────────────────────────────────────────────────

  async saveToolPackage(input: {
    toolId: string;
    files: Array<{ filename: string; content: string }>;
    languages?: string[];
    frameworks?: string[];
    description?: string;
    status?: string;
  }): Promise<{ toolId: string; created: boolean }> {
    try {
      const result = this.adminRepo.saveToolPackage(input);
      this.toolRuleStore.reloadFromRepository();
      return result;
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }

  async publishTool(toolId: string): Promise<void> {
    try {
      this.adminRepo.publishTool(toolId);
      this.toolRuleStore.reloadFromRepository();
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }

  async rollbackTool(toolId: string, version: string): Promise<void> {
    try {
      this.adminRepo.rollbackTool(toolId, version);
      this.toolRuleStore.reloadFromRepository();
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }

  async deleteTool(toolId: string): Promise<void> {
    try {
      this.adminRepo.deleteTool(toolId);
      this.toolRuleStore.reloadFromRepository();
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }

  listTools(): ToolPackageRow[] {
    return this.adminRepo.listTools();
  }

  listToolVersions(toolId: string): Array<{ version: string; releasedAt: string }> {
    return this.adminRepo.listToolVersions(toolId);
  }

  getTool(toolId: string): ToolPackageRow {
    try {
      return this.adminRepo.getTool(toolId);
    } catch (err) {
      if (err instanceof AdminError) translateAdminError(err);
      throw err;
    }
  }
}