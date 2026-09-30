import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SopRule, ProjectFeature } from '../_meta/sop-types';

/** SopCacheManager 最小契约（惰性加载仅依赖缓存目录与规则注册表；避免反向 import 形成循环） */
interface CacheManagerLike {
  getCacheDir(): string;
  getRegistry(): { getAll(): SopRule[] };
}

const DB_EXT = /\.db$/;
const SOP_MODULE_PREFIX = 'sop-module:';

/** 遍历 capabilities 对象，收集 status === 'reclaiming' 的 sop-module:* id（返回去掉前缀的模块名） */
function collectReclaimingIds(capabilities: unknown): Set<string> {
  if (typeof capabilities !== 'object' || capabilities === null) return new Set<string>();
  const reclaiming = new Set<string>();
  for (const [key, value] of Object.entries(capabilities)) {
    if (!key.startsWith(SOP_MODULE_PREFIX)) continue;
    const entry = value as { status?: unknown } | null;
    if (entry !== null && typeof entry === 'object' && entry.status === 'reclaiming') {
      reclaiming.add(key.slice(SOP_MODULE_PREFIX.length));
    }
  }
  return reclaiming;
}

/**
 * SopLazyLoader — 分模块懒加载（文档 9.5 节）
 *
 * 不是所有用户都需要所有规则。
 * TypeScript 项目不需要 Java 规则，不需要 Vue 规则。
 * 按项目特征只加载需要的模块，全量同步 50MB → 按需同步 5-10MB（节省 80%）。
 */
export class SopLazyLoader {
  private cacheManager: CacheManagerLike;

  /** 模块 → 规则 ID 列表映射 */
  private moduleMap: Record<string, string[]> = {
    typescript: [
      'typescript.type-consistency',
      'typescript.strict-mode',
      'typescript.type-safety',
      'typescript.null-safety',
    ],
    nestjs: [
      'nestjs.module-boundary',
      'nestjs.dependency-injection',
      'nestjs.controller-standards',
    ],
    quality: [
      'quality.eslint-rules',
      'quality.naming-conventions',
      'quality.complexity',
      'quality.duplication',
    ],
    security: ['security.vulnerability', 'security.malware', 'security.garbage'], // 所有项目都需要
    architecture: [
      'architecture.circular-dependency',
      'architecture.layer-boundary',
      'architecture.module-dependency',
    ],
    documentation: [
      'documentation.readme',
      'documentation.comments',
      'documentation.type-definitions',
    ],
  };

  constructor(cacheManager: CacheManagerLike) {
    this.cacheManager = cacheManager;
  }

  // ─── 核心逻辑 ──────────────────────────────────────────────

  /**
   * 根据项目特征同步需要的规则模块
   */
  async syncForProject(feature: ProjectFeature): Promise<string[]> {
    // 1. 识别项目特征 → 映射到需要的模块
    const neededModules = this.getNeededModules(feature);

    // 2. 只下载需要的规则模块
    const syncedModules: string[] = [];
    for (const module of neededModules) {
      await this.syncModule(module);
      syncedModules.push(module);
    }

    return syncedModules;
  }

  /**
   * 将项目特征映射到需要加载的模块
   */
  getNeededModules(feature: ProjectFeature): string[] {
    const modules = new Set<string>(['security', 'quality', 'architecture']);
    this.addFrameworkModules(feature, modules);
    this.addLanguageModules(feature, modules);
    return [...modules];
  }

  private addFrameworkModules(feature: ProjectFeature, modules: Set<string>): void {
    if (feature.framework) {
      const frameworkLower = feature.framework.toLowerCase();
      if (frameworkLower.includes('nestjs') || frameworkLower.includes('nest')) {
        modules.add('nestjs');
      }
    }
  }

  private addLanguageModules(feature: ProjectFeature, modules: Set<string>): void {
    if (feature.language) {
      const langLower = feature.language.toLowerCase();
      if (this.includesAny(langLower, ['typescript', 'ts'])) {
        modules.add('typescript');
      }
      if (this.includesAny(langLower, ['javascript', 'js'])) {
        modules.add('typescript');
      }
    }
  }

  private includesAny(value: string, candidates: string[]): boolean {
    return candidates.some((candidate) => value.includes(candidate));
  }

  /**
   * 同步单个模块规则到本地缓存
   *
   * @param force 为 true 时绕过 24h 新鲜窗口强制重写（用于同步后校准规则落地）
   */
  private async syncModule(module: string, force = false): Promise<void> {
    const cacheDir = this.cacheManager.getCacheDir();
    const modulePath = path.join(cacheDir, 'modules', `${module}.db`);

    if (!force && (await this.isModuleFresh(modulePath, module))) {
      return;
    }

    const registry = this.cacheManager.getRegistry();
    const ruleIds = this.moduleMap[module] ?? [];
    const moduleRules = this.collectModuleRules(registry.getAll(), module, ruleIds);

    await fs.promises.writeFile(modulePath, JSON.stringify(moduleRules, null, 2), 'utf-8');
  }

  private async isModuleFresh(modulePath: string, module: string): Promise<boolean> {
    if (module === 'security') return false;
    try {
      await fs.promises.access(modulePath);
    } catch {
      return false;
    }
    // 空数组（规则库为空时写下的占位文件）必须可重写，否则卡 24h 新鲜窗口
    try {
      const raw = await fs.promises.readFile(modulePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
    } catch {
      return false;
    }
    const stat = await fs.promises.stat(modulePath);
    return Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000;
  }

  private collectModuleRules(allRules: SopRule[], module: string, ruleIds: string[]): SopRule[] {
    return allRules.filter((r) => {
      for (const ruleId of ruleIds) {
        if (r.id.includes(ruleId) || r.tags.includes(module)) return true;
      }
      return r.id.startsWith(module);
    });
  }

  /**
   * 强制刷新所有已加载模块的缓存文件（绕过 24h 新鲜窗口）。
   *
   * 扫描引擎通过 loadSopRulesFromCache 读取 modules/*.db（REMOTE_WINS 覆盖内置模板），
   * 若同步仅更新 rules.db 而不重建 modules 缓存，校准规则不会进入扫描装载路径。
   * 每次成功同步后调用，确保 modules/*.db 与 registry 当前规则一致。
   */
  async refreshAllLoadedModules(force = true): Promise<string[]> {
    const loaded = await this.getLoadedModules();
    for (const module of loaded) {
      await this.syncModule(module, force);
    }
    return loaded;
  }

  /**
   * 获取已加载的模块列表
   */
  async getLoadedModules(): Promise<string[]> {
    const modulesDir = path.join(this.cacheManager.getCacheDir(), 'modules');
    try {
      const files = await fs.promises.readdir(modulesDir);
      return files.filter((f) => f.endsWith('.db')).map((f) => f.replace(DB_EXT, ''));
    } catch {
      return [];
    }
  }

  /**
   * 物理删除指定模块的缓存文件（cacheDir/modules/<module>.db）。
   *
   * 幂等：文件不存在时静默成功。不触碰 capability-refs.json（账本写者始终是 desktop）。
   */
  async removeModule(module: string): Promise<void> {
    const cacheDir = this.cacheManager.getCacheDir();
    const modulePath = path.join(cacheDir, 'modules', `${module}.db`);
    await fs.promises.rm(modulePath, { force: true });
  }

  /**
   * 运行层过滤钩子：读取账本中 reclaiming 的 sop-module:* id，从已加载模块中剔除。
   *
   * 账本路径 = cacheDir 上一级 capability-refs.json（sop-cache 在 .zhshield/sop-cache，父目录即 .zhshield）。
   * 读账本失败/缺失 → 返回全部已加载模块。此函数绝不抛。
   */
  async getRefsFilteredActiveModules(): Promise<string[]> {
    const loaded = await this.getLoadedModules();
    const reclaiming = await this.loadReclaimingModuleIds();
    return loaded.filter((m) => !reclaiming.has(m));
  }

  /** 读取账本中 reclaiming 的 sop-module:* id；读取/解析失败返回空集（调用方不过滤任何模块） */
  private async loadReclaimingModuleIds(): Promise<Set<string>> {
    try {
      const cacheDir = this.cacheManager.getCacheDir();
      const ledgerPath = path.join(path.dirname(cacheDir), 'capability-refs.json');
      const raw = await fs.promises.readFile(ledgerPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const capabilities =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { capabilities?: unknown }).capabilities
          : undefined;
      return collectReclaimingIds(capabilities);
    } catch {
      return new Set<string>();
    }
  }

  /**
   * 获取模块的规则
   */
  async getModuleRules(module: string): Promise<SopRule[]> {
    const modulePath = path.join(this.cacheManager.getCacheDir(), 'modules', `${module}.db`);
    try {
      const raw = await fs.promises.readFile(modulePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
}
