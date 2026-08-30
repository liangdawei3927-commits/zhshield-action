import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SopRule, ProjectFeature } from './sop-types';
import { SopRegistry } from './sop-registry';
import { SopRuleParser } from './sop-loader-parser';
import { SopRuleFileCollector } from './sop-loader-fs';
import { SopRuleRegistrar } from './sop-loader-registry';

export { SopRuleConfigError } from './dynamic-severity-config';

export interface SopLoaderOptions {
  /** SOP 规则文件的根目录，默认从 __dirname 向上查找 */
  rulesDir?: string;

  /** 知识库路径（可选外部存储） */
  knowledgeBasePath?: string;

  /** 经验库路径（可选外部存储） */
  experienceBasePath?: string;
}

/**
 * SOP 加载器 — 从文件系统或知识库/经验库加载规则到注册中心
 *
 * 职责：
 * 1. 从 sop/ 目录加载内置 YAML/JSON 规则文件
 * 2. 从知识库加载外部同步的规则
 * 3. 从经验库加载校准数据
 *
 * 内部按职责委托：
 * - SopRuleFileCollector：文件系统目录遍历与规则收集
 * - SopRuleParser：规则文件解析与 SopRule 构建
 * - SopRuleRegistrar：规则批量写入注册中心
 */
export class SopLoader {
  private registry: SopRegistry;
  private options: Required<SopLoaderOptions>;
  private collector: SopRuleFileCollector;
  private registrar: SopRuleRegistrar;

  constructor(registry: SopRegistry, options: SopLoaderOptions = {}) {
    this.registry = registry;

    // 默认规则目录：本文件所在目录的上级
    const defaultRulesDir = path.resolve(__dirname, '..');

    this.options = {
      rulesDir: options.rulesDir ?? defaultRulesDir,
      knowledgeBasePath: options.knowledgeBasePath ?? '',
      experienceBasePath: options.experienceBasePath ?? '',
    };

    this.collector = new SopRuleFileCollector(new SopRuleParser());
    this.registrar = new SopRuleRegistrar(registry);
  }

  // ─── 从文件系统加载 ────────────────────────────────────────

  /**
   * 扫描默认规则目录并加载所有规则文件
   * 按照 {rulesDir}/{domain}/{action}/ 结构推导 domain/action
   */
  async loadFromFileSystem(): Promise<number> {
    return this.loadFromDirectory(this.options.rulesDir, true);
  }

  /**
   * 从指定目录加载规则文件，追加到 registry（不清空已有规则）
   *
   * 目录结构: {dir}/{domain}/{action}/**&#47;*.yml
   * domain/action 从路径推导，YAML governance 字段会覆盖推导值
   */
  async loadFromDirectory(dir: string, replaceAll = false): Promise<number> {
    if (!fs.existsSync(dir)) {
      console.warn(`[SopLoader] Rules directory not found: ${dir}`);
      return 0;
    }
    const rules = await this.collector.collectRulesFromTree(dir);
    this.registrar.registerAll(rules, replaceAll);
    return rules.length;
  }

  // ─── 从知识库加载 ──────────────────────────────────────────

  async loadFromKnowledgeBase(rules: SopRule[]): Promise<void> {
    this.registrar.loadFromKnowledgeBase(rules);
  }

  // ─── 按项目特征加载 ────────────────────────────────────────

  /**
   * 根据项目特征只加载匹配的规则
   */
  getRulesForProject(feature: ProjectFeature): SopRule[] {
    const active = this.registry.getActive();
    return active.filter((rule) => this.matchesProject(rule, feature));
  }

  private matchesProject(rule: SopRule, feature: ProjectFeature): boolean {
    const tags = rule.tags ?? [];
    if (feature.framework && tags.includes(feature.framework)) return true;
    if (feature.language && tags.includes(feature.language)) return true;
    if (feature.features.some((f) => tags.includes(f))) return true;
    return rule.domain === 'security';
  }
}
