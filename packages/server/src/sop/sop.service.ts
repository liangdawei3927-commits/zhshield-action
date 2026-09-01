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
} from '@zh/kernel';
import type { SopRule, SopVersion, SopDiff, SopRuleFilter, SignedSopPackage } from '@zh/kernel';
import { SopDiffCalculator } from './sop-diff-calculator';

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

  constructor() {
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

    // 从文件系统加载内置规则
    try {
      const loaded = await this.loader.loadFromFileSystem();
      this.logger.log(`Loaded ${loaded} built-in SOP rules`);
    } catch (err) {
      this.logger.warn(
        `Failed to load built-in SOP rules: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── 版本 ──────────────────────────────────────────────────

  async getCurrentVersion(): Promise<SopVersion> {
    const local = await this.cacheManager.getLocalVersion();
    if (local) return local;

    // 默认版本
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

  // ─── 差异计算 ──────────────────────────────────────────────

  async computeDiff(fromVersion: string, toVersion: string): Promise<SopDiff> {
    // 差异计算职责已拆分至 SopDiffCalculator（消除 large-class）
    return this.diffCalculator.computeDiff(this.registry, fromVersion, toVersion);
  }

  // ─── 全量包 ────────────────────────────────────────────────

  async getFullPackage(_version: string): Promise<Buffer> {
    const rules = this.registry.getAll();
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
