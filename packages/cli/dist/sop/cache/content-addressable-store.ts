import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { SopRule } from '../_meta/sop-types';

/**
 * ContentAddressableStore — 内容寻址存储（文档 9.2 节）
 *
 * 相同内容只存一份，用 SHA-256 哈希做去重 key。
 * 不同版本之间，未变化的规则只存储指针，不重复存储内容。
 *
 * 存储结构：
 *   objects/
 *     sha256-aaa111.json  ← 规则内容的哈希
 *     sha256-bbb222.json
 *   manifests/
 *     v1.json  ← 版本清单，记录 [hash keys]
 *     v2.json
 */
export class ContentAddressableStore {
  private baseDir: string;
  private objectsDir: string;
  private manifestsDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.objectsDir = path.join(baseDir, 'objects');
    this.manifestsDir = path.join(baseDir, 'manifests');
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.objectsDir, { recursive: true });
    await fs.promises.mkdir(this.manifestsDir, { recursive: true });
  }

  // ─── 存储规则 ──────────────────────────────────────────────

  /**
   * 存储规则，返回内容哈希 key
   * 如果内容已存在（相同 hash），不会重复存储
   */
  async storeRule(rule: SopRule): Promise<string> {
    const content = JSON.stringify(rule);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const key = `sha256-${hash}`;
    const objectPath = path.join(this.objectsDir, `${key}.json`);

    try {
      await fs.promises.access(objectPath);
    } catch {
      await fs.promises.writeFile(objectPath, content, 'utf-8');
    }

    return key;
  }

  /**
   * 批量存储规则
   */
  async storeRules(rules: SopRule[]): Promise<Map<string, string>> {
    const keyMap = new Map<string, string>(); // ruleId → hashKey

    for (const rule of rules) {
      const key = await this.storeRule(rule);
      keyMap.set(rule.id, key);
    }

    return keyMap;
  }

  // ─── 读取规则 ──────────────────────────────────────────────

  /**
   * 通过内容哈希 key 读取规则
   */
  async getRule(hashKey: string): Promise<SopRule | null> {
    const objectPath = path.join(this.objectsDir, `${hashKey}.json`);
    try {
      const raw = await fs.promises.readFile(objectPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * 批量读取规则
   */
  async getRules(hashKeys: string[]): Promise<SopRule[]> {
    const rules: SopRule[] = [];
    for (const key of hashKeys) {
      const rule = await this.getRule(key);
      if (rule) rules.push(rule);
    }
    return rules;
  }

  // ─── 版本清单 ──────────────────────────────────────────────

  /**
   * 保存版本清单（记录版本中所有规则的 hash key 列表）
   */
  async saveManifest(version: string, ruleKeyMap: Map<string, string>): Promise<void> {
    const manifest = {
      version,
      createdAt: new Date().toISOString(),
      rules: Object.fromEntries(ruleKeyMap),
    };

    const manifestPath = path.join(this.manifestsDir, `${version}.json`);
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  /**
   * 读取版本清单
   */
  async loadManifest(version: string): Promise<Map<string, string> | null> {
    const manifestPath = path.join(this.manifestsDir, `${version}.json`);
    try {
      const raw = await fs.promises.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return new Map(Object.entries(parsed.rules));
    } catch {
      return null;
    }
  }

  // ─── 计算版本差异 ──────────────────────────────────────────

  /**
   * 计算两个版本之间的差异（用于增量更新）
   * 返回：[added ruleIds], [removed ruleIds], [modified ruleIds], [unchanged ruleIds]
   */
  async diffVersions(
    fromVersion: string,
    toVersion: string,
  ): Promise<{
    added: string[];
    removed: string[];
    modified: string[];
    unchanged: string[];
  }> {
    const fromManifest = await this.loadManifest(fromVersion);
    const toManifest = await this.loadManifest(toVersion);
    if (!fromManifest || !toManifest) {
      throw new Error('Version manifest not found');
    }
    return this.categorizeChanges(fromManifest, toManifest);
  }

  private categorizeChanges(
    fromManifest: Map<string, string>,
    toManifest: Map<string, string>,
  ): { added: string[]; removed: string[]; modified: string[]; unchanged: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];
    for (const [ruleId, hashKey] of toManifest) {
      const fromHash = fromManifest.get(ruleId);
      if (!fromHash) {
        added.push(ruleId);
      } else if (fromHash !== hashKey) {
        modified.push(ruleId);
      } else {
        unchanged.push(ruleId);
      }
    }
    for (const [ruleId] of fromManifest) {
      if (!toManifest.has(ruleId)) {
        removed.push(ruleId);
      }
    }
    return { added, removed, modified, unchanged };
  }

  // ─── 存储效率统计 ──────────────────────────────────────────

  async getStorageStats(): Promise<{
    totalObjects: number;
    totalSizeBytes: number;
    dedupSavingsPercent: number;
  }> {
    const { objectCount, totalSizeBytes } = await this.computeObjectStats();
    const dedupSavingsPercent = await this.estimateDedupSavings(objectCount);
    return { totalObjects: objectCount, totalSizeBytes, dedupSavingsPercent };
  }

  private async computeObjectStats(): Promise<{ objectCount: number; totalSizeBytes: number }> {
    let totalSizeBytes = 0;
    let objectCount = 0;
    try {
      const files = (await fs.promises.readdir(this.objectsDir)).filter(
        (f) => f !== 'node_modules',
      );
      for (const file of files) {
        const stat = await fs.promises.stat(path.join(this.objectsDir, file));
        totalSizeBytes += stat.size;
        objectCount++;
      }
    } catch {
      // 目录不存在
    }
    return { objectCount, totalSizeBytes };
  }

  private async estimateDedupSavings(objectCount: number): Promise<number> {
    let dedupSavingsPercent = 0;
    try {
      const manifestFiles = (await fs.promises.readdir(this.manifestsDir)).filter(
        (f) => f !== 'node_modules',
      );
      if (manifestFiles.length <= 1) return 0;
      let totalRuleRefs = 0;
      for (const mf of manifestFiles) {
        const raw = await fs.promises.readFile(path.join(this.manifestsDir, mf), 'utf-8');
        const manifest = JSON.parse(raw);
        totalRuleRefs += Object.keys(manifest.rules).length;
      }
      if (totalRuleRefs > 0) {
        dedupSavingsPercent = Math.round(((totalRuleRefs - objectCount) / totalRuleRefs) * 100);
      }
    } catch {
      // 忽略
    }
    return dedupSavingsPercent;
  }

  /**
   * 检查内容是否存在
   */
  async exists(hashKey: string): Promise<boolean> {
    const objectPath = path.join(this.objectsDir, `${hashKey}.json`);
    try {
      await fs.promises.access(objectPath);
      return true;
    } catch {
      return false;
    }
  }
}
