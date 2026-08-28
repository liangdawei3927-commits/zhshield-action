import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { safeJoin, PathTraversalError } from '@zh/shared';
import { resolveApiBase } from './api-base';
import { HttpError, withRetry } from './retry';

export type ToolId = 'semgrep' | 'trivy' | 'eslint' | 'dep-cruiser';

export interface ToolRuleSyncConfig {
  toolId: ToolId;
  localDir: string;
  remoteVersionUrl: string;
  remoteDownloadUrl: string;
  syncIntervalMs: number;
  remoteEmergencyUrl?: string;
}

export interface ToolRuleVersion {
  toolId: ToolId;
  version: string;
  hash: string;
  size: number;
  publishedAt: string;
}

export interface ToolRuleSyncResult {
  toolId: ToolId;
  updated: boolean;
  reason?: 'already_latest' | 'network_error' | 'hash_mismatch' | 'write_error';
  fromVersion?: string;
  toVersion?: string;
}

export interface ToolRuleFile {
  filename: string;
  content: string;
}

/** 与本地目录哈希算法一致：按相对路径排序后 sha256(path\\0 + content) */
export function hashToolRuleFiles(files: ToolRuleFile[]): string {
  const hash = crypto.createHash('sha256');
  for (const file of files.toSorted((a, b) => a.filename.localeCompare(b.filename))) {
    hash.update(`${file.filename}\0`);
    hash.update(file.content);
  }
  return hash.digest('hex');
}

export function buildDefaultToolRuleConfigs(apiBase?: string): ToolRuleSyncConfig[] {
  const base = resolveApiBase(apiBase);
  return [
    {
      toolId: 'semgrep',
      localDir: 'semgrep-rules',
      remoteVersionUrl: `${base}/rules/semgrep/version`,
      remoteDownloadUrl: `${base}/rules/semgrep/download`,
      syncIntervalMs: 24 * 60 * 60 * 1000,
      remoteEmergencyUrl: `${base}/rules/semgrep/emergency`,
    },
    {
      toolId: 'trivy',
      localDir: 'trivy-db',
      remoteVersionUrl: `${base}/rules/trivy/version`,
      remoteDownloadUrl: `${base}/rules/trivy/download`,
      syncIntervalMs: 24 * 60 * 60 * 1000,
      remoteEmergencyUrl: `${base}/rules/trivy/emergency`,
    },
    {
      toolId: 'eslint',
      localDir: 'eslint-rules',
      remoteVersionUrl: `${base}/rules/eslint/version`,
      remoteDownloadUrl: `${base}/rules/eslint/download`,
      syncIntervalMs: 7 * 24 * 60 * 60 * 1000,
    },
    {
      toolId: 'dep-cruiser',
      localDir: 'dependency-cruiser-rules',
      remoteVersionUrl: `${base}/rules/dep-cruiser/version`,
      remoteDownloadUrl: `${base}/rules/dep-cruiser/download`,
      syncIntervalMs: 24 * 60 * 60 * 1000, // 1天（30天超出32位整数上限会被截断为1ms）
    },
  ];
}

export class ToolRuleSync {
  private baseDir: string;
  private configs: Map<ToolId, ToolRuleSyncConfig>;
  private versionCache: Map<ToolId, ToolRuleVersion>;
  private timers: Map<ToolId, ReturnType<typeof setInterval>>;
  private isOnline: boolean;

  constructor(customConfigs?: ToolRuleSyncConfig[]) {
    this.baseDir = path.join(os.homedir(), '.zhshield');
    this.configs = new Map();
    this.versionCache = new Map();
    this.timers = new Map();
    this.isOnline = true;

    const cfgs = customConfigs ?? buildDefaultToolRuleConfigs();
    for (const cfg of cfgs) {
      this.configs.set(cfg.toolId, cfg);
    }
  }

  async initialize(): Promise<void> {
    for (const cfg of this.configs.values()) {
      await fs.promises.mkdir(path.join(this.baseDir, cfg.localDir), { recursive: true });
    }
    await this.loadAllVersions();
  }

  async syncTool(toolId: ToolId): Promise<ToolRuleSyncResult> {
    const cfg = this.configs.get(toolId);
    if (!cfg || !this.isOnline) {
      return { toolId, updated: false, reason: 'network_error' };
    }
    try {
      const remoteVersion = await this.fetchRemoteVersion(cfg);
      if (!remoteVersion) {
        return { toolId, updated: false, reason: 'network_error' };
      }
      const localVersion = this.versionCache.get(toolId);
      if (localVersion && localVersion.version === remoteVersion.version) {
        return { toolId, updated: false, reason: 'already_latest' };
      }
      return await this.applyUpdate(toolId, cfg, remoteVersion, localVersion);
    } catch {
      return { toolId, updated: false, reason: 'network_error' };
    }
  }

  private async applyUpdate(
    toolId: ToolId,
    cfg: ToolRuleSyncConfig,
    remoteVersion: ToolRuleVersion,
    localVersion: ToolRuleVersion | undefined,
  ): Promise<ToolRuleSyncResult> {
    const downloaded = await this.downloadRules(cfg);
    if (!downloaded) {
      return { toolId, updated: false, reason: 'network_error' };
    }
    const localDir = path.join(this.baseDir, cfg.localDir);
    await this.extractRules(downloaded, localDir);
    const computedHash = await this.computeDirHash(localDir);
    if (computedHash !== remoteVersion.hash) {
      return { toolId, updated: false, reason: 'hash_mismatch' };
    }
    this.versionCache.set(toolId, remoteVersion);
    await this.saveVersion(toolId, remoteVersion);
    return {
      toolId,
      updated: true,
      fromVersion: localVersion?.version,
      toVersion: remoteVersion.version,
    };
  }

  async syncAll(): Promise<ToolRuleSyncResult[]> {
    const results: ToolRuleSyncResult[] = [];
    for (const toolId of this.configs.keys()) {
      results.push(await this.syncTool(toolId));
    }
    return results;
  }

  async emergencyUpdate(toolId: ToolId): Promise<ToolRuleSyncResult> {
    const cfg = this.configs.get(toolId);
    if (!cfg?.remoteEmergencyUrl) {
      return { toolId, updated: false, reason: 'network_error' };
    }
    this.versionCache.delete(toolId);
    const emergencyUrl = cfg.remoteEmergencyUrl;
    try {
      const res = await withRetry(async () => {
        const r = await fetch(emergencyUrl, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!r.ok) throw new HttpError(r.status);
        return r;
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      const localDir = path.join(this.baseDir, cfg.localDir);
      await this.extractRules(buf, localDir);
      const remoteVersion = await this.fetchRemoteVersion(cfg);
      if (!remoteVersion) return { toolId, updated: false, reason: 'network_error' };
      const computedHash = await this.computeDirHash(localDir);
      if (computedHash !== remoteVersion.hash) {
        return { toolId, updated: false, reason: 'hash_mismatch' };
      }
      await this.saveVersion(toolId, remoteVersion);
      return { toolId, updated: true, toVersion: remoteVersion.version };
    } catch {
      return { toolId, updated: false, reason: 'network_error' };
    }
  }

  startPeriodicSync(): void {
    for (const cfg of this.configs.values()) {
      if (this.timers.has(cfg.toolId)) continue;
      const timer = setInterval(async () => {
        await this.syncTool(cfg.toolId);
      }, cfg.syncIntervalMs);
      this.timers.set(cfg.toolId, timer);
    }
  }

  stopPeriodicSync(): void {
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  stopToolSync(toolId: ToolId): void {
    const timer = this.timers.get(toolId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(toolId);
    }
  }

  setOnline(online: boolean): void {
    this.isOnline = online;
  }

  getConfiguredToolIds(): ToolId[] {
    return [...this.configs.keys()];
  }

  getLocalVersion(toolId: ToolId): ToolRuleVersion | undefined {
    return this.versionCache.get(toolId);
  }

  getRuleDir(toolId: ToolId): string {
    const cfg = this.configs.get(toolId);
    return path.join(this.baseDir, cfg?.localDir ?? `${toolId}-rules`);
  }

  isStale(toolId: ToolId, thresholdDays = 7): boolean {
    const version = this.versionCache.get(toolId);
    if (!version) return true;
    const daysSinceSync =
      (Date.now() - new Date(version.publishedAt).getTime()) / (24 * 60 * 60 * 1000);
    return daysSinceSync > thresholdDays;
  }

  private async fetchRemoteVersion(cfg: ToolRuleSyncConfig): Promise<ToolRuleVersion | null> {
    try {
      return await withRetry(async () => {
        const res = await fetch(cfg.remoteVersionUrl, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new HttpError(res.status);
        return (await res.json()) as ToolRuleVersion;
      });
    } catch {
      return null;
    }
  }

  private async downloadRules(cfg: ToolRuleSyncConfig): Promise<Uint8Array | null> {
    try {
      return await withRetry(async () => {
        const res = await fetch(cfg.remoteDownloadUrl, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new HttpError(res.status);
        return new Uint8Array(await res.arrayBuffer());
      });
    } catch {
      return null;
    }
  }

  private async extractRules(data: Uint8Array, targetDir: string): Promise<void> {
    const records: ToolRuleFile[] = JSON.parse(new TextDecoder().decode(data));
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    await fs.promises.mkdir(targetDir, { recursive: true });
    for (const record of records) {
      let filePath: string;
      try {
        filePath = safeJoin(targetDir, record.filename);
      } catch (err) {
        if (err instanceof PathTraversalError) {
          // 拒绝路径穿越：越界条目不写盘到 targetDir 之外
          console.warn(`[tool-rule-sync] skipping unsafe rule filename: ${record.filename}`);
          continue;
        }
        throw err;
      }
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, record.content, 'utf-8');
    }
  }

  private async computeDirHash(dir: string): Promise<string> {
    const files = await this.walkDir(dir);
    const entries: ToolRuleFile[] = [];
    for (const file of files) {
      const relative = path.relative(dir, file).split(path.sep).join('/');
      const content = await fs.promises.readFile(file, 'utf-8');
      entries.push({ filename: relative, content });
    }
    return hashToolRuleFiles(entries);
  }

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // directory may not exist yet
      return results;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.walkDir(fullPath)));
        continue;
      }
      if (entry.isFile()) {
        results.push(fullPath);
      }
    }
    return results;
  }

  private async loadAllVersions(): Promise<void> {
    const versionFile = path.join(this.baseDir, 'tool-rule-versions.json');
    try {
      const raw = await fs.promises.readFile(versionFile, 'utf-8');
      const versions: ToolRuleVersion[] = JSON.parse(raw);
      for (const v of versions) {
        this.versionCache.set(v.toolId, v);
      }
    } catch {
      // no cached versions yet
    }
  }

  private async saveVersion(toolId: ToolId, version: ToolRuleVersion): Promise<void> {
    this.versionCache.set(toolId, version);
    const versionFile = path.join(this.baseDir, 'tool-rule-versions.json');
    const all = [...this.versionCache.values()];
    await fs.promises.writeFile(versionFile, JSON.stringify(all, null, 2), 'utf-8');
  }
}
