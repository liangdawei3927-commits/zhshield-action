import { randomUUID } from 'crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { ExperienceEntry, RuleStateEntry, RuleWeightEntry, Suggestion, SyncPayload } from './types';

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/** 从 JSON 加载的状态中恢复 Date 字段（JSON 序列化后 Date 退化为 ISO string） */
function reviveDates(payload: SyncPayload): SyncPayload {
  return {
    ...payload,
    experiences: payload.experiences.map((e) => ({
      ...e,
      createdAt: new Date(e.createdAt),
      updatedAt: new Date(e.updatedAt),
    })),
    weights: payload.weights.map((w) => ({
      ...w,
      lastAdjustedAt: new Date(w.lastAdjustedAt),
    })),
    ruleStates: payload.ruleStates.map((s) => ({
      ...s,
      changedAt: new Date(s.changedAt),
    })),
  };
}

export interface EvolveEngineOptions {
  /** 状态文件路径；提供后所有变更自动落盘，重启后通过同一路径恢复 */
  dataFile?: string;
  clientId?: string;
}

export class EvolveEngine {
  private experiences = new Map<string, ExperienceEntry>();
  private ruleStates = new Map<string, RuleStateEntry>();
  private ruleWeights = new Map<string, RuleWeightEntry>();
  private clientId = '';
  private readonly dataFile: string | null;

  constructor(options: EvolveEngineOptions = {}) {
    this.clientId = options.clientId ?? '';
    this.dataFile = options.dataFile ?? null;
    if (this.dataFile) this.loadFromFile();
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
    this.persist();
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
    this.persist();
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

    this.persist();
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

    const experiences = this.listExperiences();
    const weights = this.getRuleWeights();
    const states = [...this.ruleStates.values()];

    return {
      clientId: id,
      syncedAt: new Date().toISOString(),
      experiences,
      weights,
      ruleStates: states,
      totalSynced: weights.length + states.length + experiences.length,
    };
  }

  syncFromCloud(payload: SyncPayload): { weightsImported: number; statesImported: number; experiencesImported: number } {
    const revived = reviveDates(payload);
    let weightsImported = 0;
    for (const w of revived.weights) {
      this.ruleWeights.set(w.ruleId, w);
      weightsImported++;
    }

    let statesImported = 0;
    for (const s of revived.ruleStates) {
      this.ruleStates.set(s.ruleId, s);
      statesImported++;
    }

    let experiencesImported = 0;
    for (const e of revived.experiences) {
      this.experiences.set(e.id, e);
      experiencesImported++;
    }

    if (revived.clientId) this.clientId = revived.clientId;
    this.persist();
    return { weightsImported, statesImported, experiencesImported };
  }

  async syncToFile(filePath: string): Promise<void> {
    await writeJsonFile(filePath, this.syncToCloud());
  }

  async syncFromFile(filePath: string): Promise<{ weightsImported: number; statesImported: number; experiencesImported: number }> {
    const content = await fs.readFile(filePath, 'utf-8');
    const payload: SyncPayload = JSON.parse(content);
    return this.syncFromCloud(payload);
  }

  // ─── 文件持久化 ────────────────────────────────────────────

  private persist(): void {
    if (!this.dataFile) return;
    try {
      const dir = path.dirname(this.dataFile);
      if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
      fsSync.writeFileSync(this.dataFile, JSON.stringify(this.syncToCloud(), null, 2), 'utf-8');
    } catch {
      // 持久化失败不阻断主流程（与 feedback.ts 落盘失败静默策略一致）
    }
  }

  private loadFromFile(): void {
    if (!this.dataFile) return;
    try {
      if (!fsSync.existsSync(this.dataFile)) return;
      const content = fsSync.readFileSync(this.dataFile, 'utf-8');
      this.syncFromCloud(JSON.parse(content) as SyncPayload);
    } catch {
      // 状态文件缺失 / 损坏时以空状态启动，不阻断引擎
    }
  }
}
