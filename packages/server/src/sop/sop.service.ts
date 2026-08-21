import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SopRegistry, SopLoader, SopCacheManager, SopCompressor, CompressionFormat, SopSigner, EventBus } from '@zh/kernel';
import type { SopRule, SopVersion, SopDiff, SopRuleFilter, SignedSopPackage } from '@zh/kernel';
import { SopDiffCalculator } from './sop-diff-calculator';

const SIGNING_KEY_ENV = 'ZH_SOP_SIGNING_PRIVATE_KEY';
const SIGNING_DIR = path.join(os.homedir(), '.zhshield', 'sop-signing');

/**
 * SopService — 智汇云脑 SOP 规则服务
 *
 * 职责：
 * - 管理规则生命周期（知识库组织）
 * - 计算版本差异（增量更新）
 * - 处理紧急更新
 * - 规则查询与统计
 * - 规则包 Ed25519 签名（全量包 / 紧急更新）
 */
@Injectable()
export class SopService {
  private readonly logger = new Logger(SopService.name);
  private registry: SopRegistry;
  private loader: SopLoader;
  private cacheManager: SopCacheManager;
  private compressor: SopCompressor;
  private readonly diffCalculator = new SopDiffCalculator();
  private signingPrivateKey: string;

  constructor() {
    const eventBus = new EventBus();
    this.registry = new SopRegistry(eventBus);
    this.loader = new SopLoader(this.registry);
    this.cacheManager = new SopCacheManager(this.registry);
    this.compressor = new SopCompressor();
    this.signingPrivateKey = this.loadOrCreateSigningKey();
  }

  /** 加载签名私钥：优先环境变量，否则生成并持久化到 ~/.zhshield/sop-signing/ */
  private loadOrCreateSigningKey(): string {
    const fromEnv = process.env[SIGNING_KEY_ENV];
    if (fromEnv) return fromEnv;

    const privatePath = path.join(SIGNING_DIR, 'private.pem');
    try {
      if (fs.existsSync(privatePath)) {
        return fs.readFileSync(privatePath, 'utf-8');
      }
    } catch {
      // 读取失败走生成分支
    }

    const { privateKey } = SopSigner.generateKeyPair();
    try {
      fs.mkdirSync(SIGNING_DIR, { recursive: true });
      fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
      this.logger.log(`Generated SOP signing key at ${privatePath}`);
    } catch (err) {
      this.logger.warn(
        `Failed to persist SOP signing key (in-memory only): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return privateKey;
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

  /** 返回 Ed25519 签名的全量规则包（brotli 压缩的 SignedSopPackage JSON） */
  async getFullPackage(version: string): Promise<Buffer> {
    const rules = this.registry.getAll();
    const pkg = SopSigner.signPackageWithKey(rules, this.signingPrivateKey, version);
    return this.compressor.compress(Buffer.from(JSON.stringify(pkg)), CompressionFormat.Brotli);
  }

  /** 返回当前签名公钥（PEM），供客户端验签使用 */
  getPublicKey(): string {
    return SopSigner.derivePublicKey(this.signingPrivateKey);
  }

  // ─── 紧急更新 ──────────────────────────────────────────────

  /** 返回 critical 级规则（Ed25519 签名包，桌面端应用前验签） */
  async getEmergencyRules(): Promise<SignedSopPackage> {
    const filter: SopRuleFilter = { severity: 'critical' as const };
    const rules = this.registry.query(filter);
    return SopSigner.signPackageWithKey(rules, this.signingPrivateKey, 'emergency');
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

  signPackage(secretKey: string) {
    const rules = this.registry.getAll();
    return SopSigner.signPackage(rules, secretKey);
  }

  verifyPackage(signedPkg: Parameters<typeof SopSigner.verifyPackage>[0], secretKey: string) {
    return SopSigner.verifyPackage(signedPkg, secretKey);
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
