import { Injectable, Logger } from '@nestjs/common';
import { EvolveEngine } from '@zh/evolve';
import type { ExperienceEntry, RuleStateEntry, RuleWeightEntry, Suggestion } from '@zh/evolve';

@Injectable()
export class EvolveService {
  private readonly logger = new Logger(EvolveService.name);
  private readonly engine: EvolveEngine;

  constructor() {
    this.engine = new EvolveEngine();
    this.engine.setClientId('zh-codeshield-server');
  }

  async getSuggestions(projectId: string): Promise<Suggestion[]> {
    this.logger.log(`Getting evolve suggestions for project: ${projectId}`);
    return this.engine.getSuggestions(projectId);
  }

  async recordExperience(
    entry: Omit<ExperienceEntry, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ExperienceEntry> {
    this.logger.log(`Recording experience for rule: ${entry.ruleId}`);
    const result = this.engine.recordExperience(entry);
    this.engine.autoAdjustWeights();
    return result;
  }

  async listExperiences(projectId?: string): Promise<ExperienceEntry[]> {
    return this.engine.listExperiences(projectId);
  }

  async autoAdjustWeights(): Promise<RuleWeightEntry[]> {
    this.logger.log('Auto-adjusting rule weights');
    return this.engine.autoAdjustWeights();
  }

  async getRuleWeights(): Promise<RuleWeightEntry[]> {
    return this.engine.getRuleWeights();
  }

  async getRuleWeight(ruleId: string): Promise<{ ruleId: string; weight: number }> {
    return { ruleId, weight: this.engine.getRuleWeight(ruleId) };
  }

  async changeRuleState(
    ruleId: string,
    state: RuleStateEntry['state'],
    reason: string,
    changedBy: string,
  ): Promise<RuleStateEntry> {
    this.logger.log(`Changing rule ${ruleId} state to ${state}: ${reason}`);
    return this.engine.changeRuleState(ruleId, state, reason, changedBy);
  }

  async getRuleState(ruleId: string): Promise<RuleStateEntry | undefined> {
    return this.engine.getRuleState(ruleId);
  }
}
