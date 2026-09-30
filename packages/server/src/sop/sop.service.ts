import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import {
  SopRegistry,
  SopLoader,
  SopCacheManager,
  SopCompressor,
  CompressionFormat,
  SopSigner,
  EventBus,
  computeRuleContentSha,
} from '@zh/kernel';
import type { SopRule, SopVersion, SopDiff, SopRuleFilter, SignedSopPackage } from '@zh/kernel';
import { SopDiffCalculator } from './sop-diff-calculator';
import { SopContentRepository } from './sop-content.repository';

/**
 * SopService — 智汇云脑 SOP 规则服务
 *
 * 职责：
 * - 管理规则生命周期（知识库组织）
 * - 计算版本差异（增量更新）
 * - 处理紧急更新
 * - 规则查询与统计
 * - 签名验证
 */
@Injectable()
export class SopService {
  private readonly logger = new Logger(SopService.name);
  private registry: SopRegistry;
  private loader: SopLoader;
  private cacheManager: SopCacheManager;
  private compressor: SopCompressor;
  private readonly diffCalculator = new SopDiffCalculator();
  /** Ed25519 私钥（PEM PKCS8，来自 ZH_SOP_PRIVATE_KEY）；未配置为 null */
  private readonly privateKey: string | null;
  /** Ed25519 公钥（PEM SPKI），由私钥派生；未配置为 null */
  private readonly publicKeyPem: string | null;

  constructor(private readonly contentRepo: SopContentRepository) {
    const eventBus = new EventBus();
    this.registry = new SopRegistry(eventBus);
    this.loader = new SopLoader(this.registry);
    this.cacheManager = new SopCacheManager(this.registry);
    this.compressor = new SopCompressor();

    const envKey = process.env.ZH_SOP_PRIVATE_KEY;
    if (envKey) {
      const key = crypto.createPrivateKey(envKey);
      this.privateKey = envKey;
      this.publicKeyPem = crypto
        .createPublicKey(key)
        .export({ type: 'spki', format: 'pem' })
        .toString();
    } else {
      this.privateKey = null;
      this.publicKeyPem = null;
    }
  }

  // ─── 初始化 ────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async initialize(): Promise<void> {
    // 缓存初始化（SQLite 等）失败不应阻断服务启动 — 降级为内置规则只读模式
    try {
      await this.cacheManager.initialize();
    } catch (err) {
      this.logger.warn(
        `SOP cache initialization failed, falling back to read-only built-in rules: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.loadRules();
  }

  /** 从内容仓库读库加载规则；DB 不可用/空库 → 降级内置 YAML 文件系统 */
  private async loadRules(): Promise<void> {
    // C3：优先从内容仓库（rule_content）读库；DB 不可用/空库 → 降级内置 YAML 文件系统
    const rules = this.contentRepo.getAllRules();
    if (rules && rules.length > 0) {
      this.registry.loadAll(rules);
      this.logger.log(`Loaded ${rules.length} SOP rules from content repository`);
      return;
    }
    const source = rules === null ? 'unavailable' : 'empty';
    this.logger.warn(`Content repository ${source}, falling back to built-in filesystem rules`);

    try {
      const loaded = await this.loader.loadFromFileSystem();
      this.logger.log(`Loaded ${loaded} built-in SOP rules`);
    } catch (err) {
      this.logger.warn(
        `Failed to load built-in SOP rules: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** C4 管理写路径完成后调用：从内容仓库重新加载规则到 registry（读路径立即生效，不降级文件系统） */
  async reloadFromRepository(): Promise<void> {
    const rules = this.contentRepo.getAllRules();
    if (rules === null) {
      this.logger.warn('Content repository unavailable, keeping current registry');
      return;
    }
    this.registry.loadAll(rules);
    this.logger.log(`Reloaded ${rules.length} SOP rules from content repository`);
  }

  // ─── 版本 ──────────────────────────────────────────────────

  async getCurrentVersion(): Promise<SopVersion> {
    const local = await this.cacheManager.getLocalVersion();
    if (local) return local;

    // 无本地版本文件时从规则内容派生版本号（对齐 tool-rule-store.deriveVersion 模式）：
    // 规则内容（含校准/阈值修订）变化 → contentHash 变化 → 版本号变化，
    // 客户端 compareVersions 才能识别出并重新拉取，否则 desktop 永远 already_latest。
    const rules = this.registry.getAll();
    if (rules.length === 0) {
      // 空规则集：回退默认版本
      return {
        version: '1.2026.07.28.001',
        knowledge: '1.2026.07.28',
        experience: '1.2026.07.28',
        malware: '1.2026.07.28',
        publishedAt: new Date('2026-07-28'),
        hash: '',
        size: 0,
      };
    }

    // 规范序（按 id 排序）聚合各规则内容 SHA256，保证派生版本只随内容变化
    const canonical = rules
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map((r) => `${r.id}:${computeRuleContentSha(r)}`)
      .join('\n');
    const contentHash = crypto.createHash('sha256').update(canonical).digest('hex');

    // 版本日期取规则最大更新时间：升序字符串比较永远判定 remote > local → proceed（增量拉取）
    const maxUpdatedAt = rules.reduce(
      (m, r) => (r.updatedAt && r.updatedAt > m ? r.updatedAt : m),
      new Date(0),
    );
    const pad = (n: number) => String(n).padStart(2, '0');
    const ymd = `${pad(maxUpdatedAt.getUTCFullYear())}.${pad(maxUpdatedAt.getUTCMonth() + 1)}.${pad(
      maxUpdatedAt.getUTCDate(),
    )}`;
    // 修订号取内容哈希前 12 位命名的数字段，保证同日期内内容变更也换版本
    const revision = (parseInt(contentHash.slice(0, 12), 16) % 1000).toString().padStart(3, '0');

    return {
      version: `1.${ymd}.${revision}`,
      knowledge: `1.${ymd}`,
      experience: `1.${ymd}`,
      malware: `1.${ymd}`,
      publishedAt: maxUpdatedAt,
      hash: contentHash,
      size: rules.length,
    };
  }

  // ─── 差异计算 ──────────────────────────────────────────────

  async computeDiff(fromVersion: string, toVersion: string): Promise<SopDiff> {
    // 差异计算职责已拆分至 SopDiffCalculator（消除 large-class）
    return this.diffCalculator.computeDiff(this.registry, fromVersion, toVersion);
  }

  // ─── 全量包 ────────────────────────────────────────────────

  async getFullPackage(version: string): Promise<Buffer> {
    const rules = this.registry.getAll();

    // 如果配置了私钥，返回签名包（Ed25519）；否则返回裸 JSON（向后兼容）
    if (this.privateKey) {
      const signedPkg = SopSigner.signPackage(rules, this.privateKey, version);
      const json = JSON.stringify(signedPkg);
      return this.compressor.compress(Buffer.from(json), CompressionFormat.Brotli);
    }

    // 未配置私钥时返回裸规则数组（向后兼容旧版客户端）
    const json = JSON.stringify(rules);
    return this.compressor.compress(Buffer.from(json), CompressionFormat.Brotli);
  }

  // ─── 紧急更新 ──────────────────────────────────────────────

  async getEmergencyRules(): Promise<SopRule[]> {
    // 返回所有 critical 级别的安全规则
    const filter: SopRuleFilter = { severity: 'critical' as const };
    return this.registry.query(filter);
  }

  // ─── 规则管理 ──────────────────────────────────────────────

  getAllRules(): SopRule[] {
    return this.registry.getAll();
  }

  getActiveRules(): SopRule[] {
    return this.registry.getActive();
  }

  getRule(id: string): SopRule | undefined {
    return this.registry.get(id);
  }

  queryRules(filter: SopRuleFilter): SopRule[] {
    return this.registry.query(filter);
  }

  getStats() {
    return this.registry.getStats();
  }

  async evaluateLifecycle() {
    return this.registry.evaluateLifecycle();
  }

  // ─── 签名与验证 ────────────────────────────────────────────

  /** 用 Ed25519 私钥（ZH_SOP_PRIVATE_KEY）签名当前规则包；未配置私钥时抛错（fail-closed） */
  signPackage(): SignedSopPackage {
    if (!this.privateKey) {
      throw new Error('ZH_SOP_PRIVATE_KEY 未配置，无法签名 SOP 规则包');
    }
    const rules = this.registry.getAll();
    return SopSigner.signPackage(rules, this.privateKey);
  }

  /** 返回 Ed25519 公钥（PEM SPKI），供桌面端验签；未配置私钥时返回 null */
  getPublicKeyPem(): string | null {
    return this.publicKeyPem;
  }

  verifyPackage(signedPkg: Parameters<typeof SopSigner.verifyPackage>[0], publicKey: string) {
    return SopSigner.verifyPackage(signedPkg, publicKey);
  }

  // ─── 暴露内部组件 ──────────────────────────────────────────

  getRegistry(): SopRegistry {
    return this.registry;
  }

  getCacheManager(): SopCacheManager {
    return this.cacheManager;
  }

  getCompressor(): SopCompressor {
    return this.compressor;
  }
}
