import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { safeJoinReal, PathTraversalError } from '@zh/shared';
import { resolveApiBase } from './api-base';
import { HttpError, withRetry } from './retry';
import { getReclaimingToolRuleIds } from './capability-refs-reader';

/** 能力到期物理删除阈值：reclaiming 持续超过该天数（严格大于）才删除（06 §4.3 窗口参数） */
export const EXPIRY_THRESHOLD_DAYS = 7;

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

/** 远程版本探测：网络失败/非 2xx 返回 null（由调用方降级为 network_error） */
async function fetchRemoteVersion(cfg: ToolRuleSyncConfig): Promise<ToolRuleVersion | null> {
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

/** 远程规则包下载：网络失败/非 2xx 返回 null */
async function downloadRulePackage(cfg: ToolRuleSyncConfig): Promise<Uint8Array | null> {
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

/** 递归收集目录下规则文件（node_modules 跳过；目录不存在返回空） */
async function walkRuleDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  const subdirPromises: Promise<string[]>[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      subdirPromises.push(walkRuleDir(path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile()) {
      results.push(path.join(dir, entry.name));
    }
  }
  const subdirResults = await Promise.all(subdirPromises);
  for (const sr of subdirResults) {
    results.push(...sr);
  }
  return results;
}

/** 解包规则包写入目标目录；路径穿越条目拒绝写盘（safeJoinReal 白名单越界跳过） */
export async function extractRulePackage(data: Uint8Array, targetDir: string): Promise<void> {
  const records: ToolRuleFile[] = JSON.parse(new TextDecoder().decode(data));
  await fs.promises.rm(targetDir, { recursive: true, force: true });
  await fs.promises.mkdir(targetDir, { recursive: true });
  for (const record of records) {
    let filePath: string;
    try {
      filePath = safeJoinReal(targetDir, record.filename);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        // 拒绝路径穿越：越界条目不写盘到 targetDir 之外
        console.warn(`[tool-rule-sync] skipping unsafe rule filename: ${record.filename}`);
        continue;
      }
      throw err;
    }
    // eslint-disable-next-line perf/perf-no-serial-await -- arg depends on loop var via dataflow
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, record.content, 'utf-8');
  }
}

/** 载入版本缓存文件（不存在 → 空缓存；损坏 → 空缓存） */
async function loadVersionCache(
  baseDir: string,
  versionCache: Map<ToolId, ToolRuleVersion>,
): Promise<void> {
  const versionFile = path.join(baseDir, 'tool-rule-versions.json');
  try {
    const raw = await fs.promises.readFile(versionFile, 'utf-8');
    const versions: ToolRuleVersion[] = JSON.parse(raw);
    for (const v of versions) {
      versionCache.set(v.toolId, v);
    }
  } catch {
    // no cached versions yet
  }
}

/** 持久化版本缓存文件（全量覆写） */
async function persistVersionCache(
  baseDir: string,
  versionCache: Map<ToolId, ToolRuleVersion>,
): Promise<void> {
  const versionFile = path.join(baseDir, 'tool-rule-versions.json');
  const all = [...versionCache.values()];
  await fs.promises.writeFile(versionFile, JSON.stringify(all, null, 2), 'utf-8');
}

/** 目录内容哈希：相对路径排序后走 hashToolRuleFiles（与下发哈希算法一致） */
async function computeRuleDirHash(dir: string): Promise<string> {
  const files = await walkRuleDir(dir);
  const entries: ToolRuleFile[] = [];
  for (const file of files) {
    const relative = path.relative(dir, file).split(path.sep).join('/');
    const content = await fs.promises.readFile(file, 'utf-8');
    entries.push({ filename: relative, content });
  }
  return hashToolRuleFiles(entries);
}

export class ToolRuleSync {
  private _baseDir: string;
  private configs: Map<ToolId, ToolRuleSyncConfig>;
  private versionCache: Map<ToolId, ToolRuleVersion>;
  private timers: Map<ToolId, ReturnType<typeof setInterval>>;
  private isOnline: boolean;
  private remoteToolIds: readonly ToolId[] | null;

  constructor(customConfigs?: ToolRuleSyncConfig[], baseDir?: string) {
    this._baseDir = baseDir ?? path.join(os.homedir(), '.zhshield');
    this.configs = new Map();
    this.versionCache = new Map();
    this.timers = new Map();
    this.isOnline = true;
    this.remoteToolIds = null;

    const cfgs = customConfigs ?? buildDefaultToolRuleConfigs();
    for (const cfg of cfgs) {
      this.configs.set(cfg.toolId, cfg);
    }
  }

  /** 规则根目录（只读暴露，供到期扫描等外部逻辑定位账本/版本文件） */
  get baseDir(): string {
    return this._baseDir;
  }

  async initialize(): Promise<void> {
    for (const cfg of this.configs.values()) {
      await fs.promises.mkdir(path.join(this._baseDir, cfg.localDir), { recursive: true });
    }
    await loadVersionCache(this._baseDir, this.versionCache);
  }

  async syncTool(toolId: ToolId): Promise<ToolRuleSyncResult> {
    const cfg = this.configs.get(toolId);
    if (!cfg || !this.isOnline) {
      return { toolId, updated: false, reason: 'network_error' };
    }
    try {
      const remoteVersion = await fetchRemoteVersion(cfg);
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
    const downloaded = await downloadRulePackage(cfg);
    if (!downloaded) {
      return { toolId, updated: false, reason: 'network_error' };
    }
    const localDir = path.join(this._baseDir, cfg.localDir);
    await extractRulePackage(downloaded, localDir);
    const computedHash = await computeRuleDirHash(localDir);
    if (computedHash !== remoteVersion.hash) {
      return { toolId, updated: false, reason: 'hash_mismatch' };
    }
    this.versionCache.set(toolId, remoteVersion);
    await persistVersionCache(this._baseDir, this.versionCache);
    return {
      toolId,
      updated: true,
      fromVersion: localVersion?.version,
      toVersion: remoteVersion.version,
    };
  }

  async syncAll(): Promise<ToolRuleSyncResult[]> {
    const results: ToolRuleSyncResult[] = [];
    for (const toolId of this.getActiveToolIds()) {
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
      const localDir = path.join(this._baseDir, cfg.localDir);
      await extractRulePackage(buf, localDir);
      const remoteVersion = await fetchRemoteVersion(cfg);
      if (!remoteVersion) return { toolId, updated: false, reason: 'network_error' };
      const computedHash = await computeRuleDirHash(localDir);
      if (computedHash !== remoteVersion.hash) {
        return { toolId, updated: false, reason: 'hash_mismatch' };
      }
      this.versionCache.set(toolId, remoteVersion);
      await persistVersionCache(this._baseDir, this.versionCache);
      return { toolId, updated: true, toVersion: remoteVersion.version };
    } catch {
      return { toolId, updated: false, reason: 'network_error' };
    }
  }

  startPeriodicSync(): void {
    for (const toolId of this.getActiveToolIds()) {
      const cfg = this.configs.get(toolId);
      if (!cfg || this.timers.has(toolId)) continue;
      const timer = setInterval(async () => {
        await this.syncTool(toolId);
      }, cfg.syncIntervalMs);
      this.timers.set(toolId, timer);
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

  /**
   * 设置服务端 resolve 返回的远程工具白名单。
   * 设置后 getConfiguredToolIds / syncAll / startPeriodicSync 仅作用于
   * configuredIds ∩ remoteIds 的交集。传 null 或不调用 → 恢复全量（离线降级）。
   */
  setRemoteToolIds(ids: readonly ToolId[] | null): void {
    this.remoteToolIds = ids;
  }

  getRemoteToolIds(): readonly ToolId[] | null {
    return this.remoteToolIds;
  }

  /**
   * 当前活跃的工具 ID 列表：远程白名单与本地配置的交集，
   * 再剔除 capability-refs 账本中 status === 'reclaiming' 的工具。
   * 无远程白名单 → 全部配置（离线/无 org 降级）。
   */
  private getActiveToolIds(): ToolId[] {
    const reclaiming = getReclaimingToolRuleIds(this._baseDir);
    return this.getScopedToolIds().filter((id) => !reclaiming.has(id));
  }

  /**
   * 未剔 reclaiming 的工具清单（仅远程交集；无远程白名单 → 全部配置）。
   * 供「领取」步骤用于唤醒（claim 必须先于运行层过滤，否则 reclaiming 能力
   * 永远进不了 claim 列表，7 天窗口内重加同栈项目无法复用本地文件）。
   */
  getUnfilteredToolIds(): ToolId[] {
    return this.getScopedToolIds();
  }

  /** 远程白名单与本地配置的交集（无远程白名单 → 全部配置） */
  private getScopedToolIds(): ToolId[] {
    const configured = [...this.configs.keys()];
    if (!this.remoteToolIds) return configured;
    const remoteSet = new Set(this.remoteToolIds);
    return configured.filter((id) => remoteSet.has(id));
  }

  /** 能力引用回收过滤后的活跃工具（getActiveToolIds 的公共别名） */
  getRefsFilteredActiveTools(): ToolId[] {
    return this.getActiveToolIds();
  }

  getConfiguredToolIds(): ToolId[] {
    return this.getRefsFilteredActiveTools();
  }

  getLocalVersion(toolId: ToolId): ToolRuleVersion | undefined {
    return this.versionCache.get(toolId);
  }

  getRuleDir(toolId: ToolId): string {
    const cfg = this.configs.get(toolId);
    return path.join(this._baseDir, cfg?.localDir ?? `${toolId}-rules`);
  }

  /**
   * 物理删除指定工具的规则目录 + 版本缓存条目 + 周期同步 timer；幂等。
   * 不触碰 capability-refs.json（账本写入方始终是 desktop，单写者原则）。
   */
  async removeRules(toolId: ToolId): Promise<void> {
    this.stopToolSync(toolId);
    await fs.promises.rm(this.getRuleDir(toolId), { recursive: true, force: true });
    this.versionCache.delete(toolId);
    await persistVersionCache(this._baseDir, this.versionCache);
  }

  isStale(toolId: ToolId, thresholdDays = 7): boolean {
    const version = this.versionCache.get(toolId);
    if (!version) return true;
    const daysSinceSync =
      (Date.now() - new Date(version.publishedAt).getTime()) / (24 * 60 * 60 * 1000);
    return daysSinceSync > thresholdDays;
  }
}
