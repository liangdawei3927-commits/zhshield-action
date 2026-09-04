import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { isToolInScope } from '@zh/shared';
import { ToolRuleSync } from './tool-rule-sync';
import type { ToolRuleSyncResult, ToolId as SyncToolId } from './tool-rule-sync';
import { ExperienceReporter } from './experience-reporter';
import type { ExperienceRecord, ExperienceReportResult } from './experience-reporter';
import type { ProjectFeature } from '../_meta/sop-types';

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export type ToolId = SyncToolId;

export interface VersionLock {
  toolId: ToolId;
  lockedVersion: string;
  lockedAt: string;
  reason: string;
}

export interface ExperienceSyncPayload {
  experiences: ExperienceRecord[];
}

export interface WisdomBrainSyncResult {
  ruleSyncResults: ToolRuleSyncResult[];
  experienceResult: ExperienceReportResult | null;
  lockedVersions: VersionLock[];
}

export class WisdomBrainSync {
  private toolRuleSync: ToolRuleSync;
  private experienceReporter: ExperienceReporter;
  private lockedVersions: Map<ToolId, VersionLock>;
  private lockFilePath: string;

  constructor(options?: {
    toolRuleSync?: ToolRuleSync;
    experienceReporter?: ExperienceReporter;
    lockFilePath?: string;
  }) {
    this.toolRuleSync = options?.toolRuleSync ?? new ToolRuleSync();
    this.experienceReporter = options?.experienceReporter ?? new ExperienceReporter();
    this.lockedVersions = new Map();
    this.lockFilePath =
      options?.lockFilePath ?? path.join(os.homedir(), '.zhshield', 'version-locks.json');
  }

  async initialize(): Promise<void> {
    await this.toolRuleSync.initialize();
    await this.experienceReporter.initialize();
    await this.loadLockedVersions();
  }

  // ─── 云端规则下发 ─────────────────────────────────────

  async syncToolRules(toolId: ToolId): Promise<ToolRuleSyncResult> {
    const result = await this.toolRuleSync.syncTool(toolId);
    if (result.updated && result.toVersion) {
      const lock = this.lockedVersions.get(toolId);
      if (lock && lock.lockedVersion !== result.toVersion) {
        result.reason = 'write_error';
        return { ...result, updated: false };
      }
    }
    return result;
  }

  /**
   * 全量同步工具规则。可传入画像 → 仅下发画像 scope 内的工具（security 恒含、
   * eslint/dep-cruiser 按 language 裁剪）；缺省 → 全量下发（保持原有降级语义）。
   */
  async syncAllRules(feature?: ProjectFeature): Promise<ToolRuleSyncResult[]> {
    const results: ToolRuleSyncResult[] = [];
    for (const toolId of this.getConfiguredTools(feature)) {
      results.push(await this.syncToolRules(toolId));
    }
    return results;
  }

  // ─── 经验回写 ─────────────────────────────────────────

  async syncExperience(records: ExperienceRecord[]): Promise<ExperienceReportResult> {
    for (const record of records) {
      await this.experienceReporter.submit(record);
    }
    return this.experienceReporter.flush();
  }

  async syncExperienceBatch(records: ExperienceRecord[]): Promise<ExperienceReportResult> {
    await this.experienceReporter.submitBatch(records);
    return this.experienceReporter.flush();
  }

  // ─── 版本锁定 ─────────────────────────────────────────

  lockVersion(toolId: ToolId, version: string, reason = 'manual'): VersionLock {
    const lock: VersionLock = {
      toolId,
      lockedVersion: version,
      lockedAt: new Date().toISOString(),
      reason,
    };
    this.lockedVersions.set(toolId, lock);
    return lock;
  }

  unlockVersion(toolId: ToolId): boolean {
    return this.lockedVersions.delete(toolId);
  }

  getLockedVersions(): VersionLock[] {
    return [...this.lockedVersions.values()];
  }

  getVersionLock(toolId: ToolId): VersionLock | undefined {
    return this.lockedVersions.get(toolId);
  }

  isVersionLocked(toolId: ToolId): boolean {
    return this.lockedVersions.has(toolId);
  }

  async loadLockedVersions(): Promise<void> {
    try {
      const content = await fs.readFile(this.lockFilePath, 'utf-8');
      const locks: VersionLock[] = JSON.parse(content);
      this.lockedVersions.clear();
      for (const lock of locks) {
        this.lockedVersions.set(lock.toolId, lock);
      }
    } catch {
      this.lockedVersions.clear();
    }
  }

  async saveLockedVersions(): Promise<void> {
    await writeJsonFile(this.lockFilePath, this.getLockedVersions());
  }

  // ─── 一键同步 ─────────────────────────────────────────

  async syncAll(params?: {
    experiences?: ExperienceRecord[];
    feature?: ProjectFeature;
  }): Promise<WisdomBrainSyncResult> {
    const ruleSyncResults = await this.syncAllRules(params?.feature);

    let experienceResult: ExperienceReportResult | null = null;
    if (params?.experiences && params.experiences.length > 0) {
      experienceResult = await this.syncExperienceBatch(params.experiences);
    }

    await this.saveLockedVersions();

    return {
      ruleSyncResults,
      experienceResult,
      lockedVersions: this.getLockedVersions(),
    };
  }

  // ─── 状态 ─────────────────────────────────────────────

  setOnline(online: boolean): void {
    this.toolRuleSync.setOnline(online);
    this.experienceReporter.setOnline(online);
  }

  getRuleSync(): ToolRuleSync {
    return this.toolRuleSync;
  }

  getExperienceReporter(): ExperienceReporter {
    return this.experienceReporter;
  }

  private getConfiguredTools(feature?: ProjectFeature): ToolId[] {
    const tools = this.toolRuleSync.getConfiguredToolIds();
    if (!feature) return tools;
    return tools.filter((toolId) => isToolInScope(toolId, feature));
  }
}
