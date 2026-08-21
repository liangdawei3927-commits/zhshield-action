import { randomUUID } from 'crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExperienceEntry, RuleStateEntry, RuleWeightEntry, Suggestion, SyncPayload } from './types';

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export class EvolveEngine {
  private experiences = new Map<string, ExperienceEntry>();
  private ruleStates = new Map<string, RuleStateEntry>();
  private ruleWeights = new Map<string, RuleWeightEntry>();
  private clientId = '';
  private engineOptions: { dataFile?: string; clientId?: string } = {};

  constructor(options: { dataFile?: string; clientId?: string } = {}) {
    this.engineOptions = options;
    if (options.clientId) this.clientId = options.clientId;
  }

  setClientId(id: string): void {
    this.clientId = id;
  }

  recordExperience(entry: Omit<ExperienceEntry, 'id' | 'createdAt' | 'updatedAt'>): ExperienceEntry {
    const now = new Date();
    const experience: ExperienceEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.experiences.set(experience.id, experience);
    return experience;
  }

  getSuggestions(projectId: string, context?: { ruleId?: string }): Suggestion[] {
    const entries = [...this.experiences.values()]
      .filter((e) => e.projectId === projectId)
      .filter((e) => !context?.ruleId || e.ruleId === context.ruleId);

    const byRule = new Map<string, ExperienceEntry[]>();
    for (const e of entries) {
      if (!byRule.has(e.ruleId)) byRule.set(e.ruleId, []);
      byRule.get(e.ruleId)!.push(e);
    }

    const suggestions: Suggestion[] = [];
    for (const [ruleId, ruleEntries] of byRule) {
      const truePositives = ruleEntries.filter((e) => e.type === 'true-positive').length;
      const total = ruleEntries.length;
      const confidence = total > 0 ? truePositives / total : 0;

      if (confidence < 0.5 && total >= 3) {
        suggestions.push({
          ruleId,
          message: `Rule ${ruleId} has high false-positive rate (${total - truePositives}/${total}). Weight auto-adjusted.`,
          confidence,
          source: 'evolve-engine',
        });
      }
    }
    return suggestions;
  }

  changeRuleState(ruleId: string, state: RuleStateEntry['state'], reason: string, changedBy: string): RuleStateEntry {
    const entry: RuleStateEntry = { ruleId, state, reason, changedAt: new Date(), changedBy };
    this.ruleStates.set(ruleId, entry);
    return entry;
  }

  getRuleState(ruleId: string): RuleStateEntry | undefined {
    return this.ruleStates.get(ruleId);
  }

  listExperiences(projectId?: string): ExperienceEntry[] {
    let results = [...this.experiences.values()];
    if (projectId) results = results.filter((e) => e.projectId === projectId);
    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  autoAdjustWeights(): RuleWeightEntry[] {
    const byRule = new Map<string, ExperienceEntry[]>();
    for (const e of this.experiences.values()) {
      if (!byRule.has(e.ruleId)) byRule.set(e.ruleId, []);
      byRule.get(e.ruleId)!.push(e);
    }

    const results: RuleWeightEntry[] = [];
    for (const [ruleId, entries] of byRule) {
      const falsePositives = entries.filter((e) => e.type === 'false-positive').length;
      const total = entries.length;
      const fpRate = total > 0 ? falsePositives / total : 0;

      let weight = 1.0;
      if (total >= 3) {
        weight = Math.max(0.1, 1.0 - fpRate * 0.8);
      }

      const entry: RuleWeightEntry = {
        ruleId,
        weight,
        falsePositiveRate: fpRate,
        totalSamples: total,
        lastAdjustedAt: new Date(),
      };
      this.ruleWeights.set(ruleId, entry);
      results.push(entry);
    }

    return results;
  }

  getRuleWeight(ruleId: string): number {
    return this.ruleWeights.get(ruleId)?.weight ?? 1.0;
  }

  getRuleWeights(): RuleWeightEntry[] {
    return [...this.ruleWeights.values()];
  }

  syncToCloud(clientId?: string): SyncPayload {
    const id = clientId || this.clientId || randomUUID();
    if (!this.clientId) this.clientId = id;

    const weights = this.getRuleWeights();
    const states = [...this.ruleStates.values()];

    return {
      clientId: id,
      syncedAt: new Date().toISOString(),
      weights,
      ruleStates: states,
      totalSynced: weights.length + states.length,
    };
  }

  syncFromCloud(payload: SyncPayload): { weightsImported: number; statesImported: number } {
    let weightsImported = 0;
    for (const w of payload.weights) {
      this.ruleWeights.set(w.ruleId, w);
      weightsImported++;
    }

    let statesImported = 0;
    for (const s of payload.ruleStates) {
      this.ruleStates.set(s.ruleId, s);
      statesImported++;
    }

    return { weightsImported, statesImported };
  }

  async syncToFile(filePath: string): Promise<void> {
    await writeJsonFile(filePath, this.syncToCloud());
  }

  async syncFromFile(filePath: string): Promise<{ weightsImported: number; statesImported: number }> {
    const content = await fs.readFile(filePath, 'utf-8');
    const payload: SyncPayload = JSON.parse(content);
    return this.syncFromCloud(payload);
  }
}
