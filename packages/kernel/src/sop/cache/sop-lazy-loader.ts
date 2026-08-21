import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SopRule, ProjectFeature } from '../_meta/sop-types';
import type { SopCacheManager } from './sop-cache-manager';

const DB_EXT = /\.db$/;

/**
 * SopLazyLoader — 分模块懒加载（文档 9.5 节）
 *
 * 不是所有用户都需要所有规则。
 * TypeScript 项目不需要 Java 规则，不需要 Vue 规则。
 * 按项目特征只加载需要的模块，全量同步 50MB → 按需同步 5-10MB（节省 80%）。
 */
export class SopLazyLoader {
  private cacheManager: SopCacheManager;

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
    security: [
      'security.vulnerability',
      'security.malware',
      'security.garbage',
    ], // 所有项目都需要
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

  constructor(cacheManager: SopCacheManager) {
    this.cacheManager = cacheManager;
  }

  // ─── 核心逻辑 ──────────────────────────────────────────────

  /**
   * 根据项目特征同步需要的规则模块
   */
  async syncForProject(feature: ProjectFeature): Promise<string[]> {
    // 1. 识别项目特征 → 映射到需要的模块
    const neededModules = this.mapFeaturesToModules(feature);

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
  private mapFeaturesToModules(feature: ProjectFeature): string[] {
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
   */
  private async syncModule(module: string): Promise<void> {
    const cacheDir = this.cacheManager.getCacheDir();
    const modulePath = path.join(cacheDir, 'modules', `${module}.db`);

    if (await this.isModuleFresh(modulePath, module)) {
      return;
    }

    const registry = this.cacheManager.getRegistry();
    const ruleIds = this.moduleMap[module] ?? [];
    const moduleRules = this.collectModuleRules(registry.getAll(), module, ruleIds);

    await fs.promises.writeFile(modulePath, JSON.stringify(moduleRules, null, 2), 'utf-8');
  }

  private async isModuleFresh(modulePath: string, module: string): Promise<boolean> {
    if (!fs.existsSync(modulePath) || module === 'security') return false;
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
   * 获取已加载的模块列表
   */
  async getLoadedModules(): Promise<string[]> {
    const modulesDir = path.join(this.cacheManager.getCacheDir(), 'modules');
    try {
      const files = await fs.promises.readdir(modulesDir);
      return files
        .filter((f) => f.endsWith('.db'))
        .map((f) => f.replace(DB_EXT, ''));
    } catch {
      return [];
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
