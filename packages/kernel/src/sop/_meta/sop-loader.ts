import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SopRule, ProjectFeature } from './sop-types';
import { ruleMatchesProject } from './rule-project-match';
import { SopRegistry } from './sop-registry';
import { SopRuleParser } from './sop-loader-parser';
import { SopRuleFileCollector } from './sop-loader-fs';
import { SopRuleRegistrar } from './sop-loader-registry';
import { filterBuiltRules, type SopRuleIssue } from './sop-field-validation';

/** 云端同步路径的问题归因标识（与文件路径区分，便于诊断时判断来源） */
const CLOUD_SYNC_ORIGIN = 'cloud-sync';

/** SOP 加载器配置：三项路径均可省略，省略时使用内置默认值 */
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
  private parser: SopRuleParser;

  constructor(registry: SopRegistry, options: SopLoaderOptions = {}) {
    this.registry = registry;

    // 默认规则目录：优先 presets/sop-templates（现行模板布局），不存在时回退旧版根布局，保证 src/dist 一致
    const sopRoot = path.resolve(__dirname, '..');
    const templatesDir = path.resolve(sopRoot, 'presets', 'sop-templates');
    const defaultRulesDir = fs.existsSync(templatesDir) ? templatesDir : sopRoot;

    this.options = {
      rulesDir: options.rulesDir ?? defaultRulesDir,
      knowledgeBasePath: options.knowledgeBasePath ?? '',
      experienceBasePath: options.experienceBasePath ?? '',
    };

    this.parser = new SopRuleParser();
    this.collector = new SopRuleFileCollector(this.parser);
    this.registrar = new SopRuleRegistrar(registry);
  }

  /** 本次进程内累计的加载期校验问题（fatal 已拒 / warn 已纠正），供诊断消费 */
  getRuleIssues(): readonly SopRuleIssue[] {
    return this.parser.getIssues();
  }

  /** 清空问题累计；调用方在开始新一轮整库加载前使用 */
  clearRuleIssues(): void {
    this.parser.clearIssues();
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
    try {
      await fs.promises.access(dir);
    } catch {
      console.warn(`[SopLoader] Rules directory not found: ${dir}`);
      return 0;
    }
    const rules = await this.collector.collectRulesFromTree(dir);
    this.registrar.registerAll(rules, replaceAll);
    return rules.length;
  }

  // ─── 从知识库加载 ──────────────────────────────────────────

  /**
   * 从知识库（云端同步）加载规则。
   *
   * 🔴 这条路径**不经过 parser**：`PipelineRunner` 拿到的是已构建的扁平 `SopRule`，
   * 原实现直接交给 registrar 写库 ⇒ 云端下发 `status: "actived"`（拼错）会让规则
   * 进入 registry 却永远匹配不到 `getActive()`，**静默空跑且本地零告警**。
   * 此处补对象级白名单校验，拒收非法规则并留痕。
   */
  async loadFromKnowledgeBase(rules: SopRule[]): Promise<void> {
    const { accepted, issues } = filterBuiltRules(rules, CLOUD_SYNC_ORIGIN);
    this.parser.reportIssues(issues);
    this.registrar.loadFromKnowledgeBase(accepted);
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
    return ruleMatchesProject(rule, feature);
  }
}
