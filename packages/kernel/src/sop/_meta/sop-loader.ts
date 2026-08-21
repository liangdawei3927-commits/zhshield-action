import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  SopRule,
  RuleServes,
  GovernanceDomain,
  ActionType,
  DataSource,
  RuleLifecycleStatus,
  ExecutionMode,
  ProjectFeature,
} from './sop-types';
import { SopRegistry } from './sop-registry';

const RULE_FILE_EXT = /\.(yml|yaml|json)$/i;

/** priority → severity 映射表（替代 priorityToSeverity 中的 switch 分派） */
const PRIORITY_TO_SEVERITY = new Map<string, SopRule['severity']>([
  ['critical', 'critical'],
  ['high', 'high'],
  ['medium', 'medium'],
  ['low', 'low'],
]);

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
 */
// allow: SIZE_OK — 单文件职责为"规则加载"，基线已超 250 LOC，本任务约束仅允许最小增量、禁止拆分
export class SopLoader {
  private registry: SopRegistry;
  private options: Required<SopLoaderOptions>;

  constructor(registry: SopRegistry, options: SopLoaderOptions = {}) {
    this.registry = registry;

    // 默认规则目录：本文件所在目录的上级
    const defaultRulesDir = path.resolve(__dirname, '..');

    this.options = {
      rulesDir: options.rulesDir ?? defaultRulesDir,
      knowledgeBasePath: options.knowledgeBasePath ?? '',
      experienceBasePath: options.experienceBasePath ?? '',
    };
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
    const rules = await this.collectRulesFromTree(dir);
    this.registerAll(rules, replaceAll);
    return rules.length;
  }

  private async collectRulesFromTree(dir: string): Promise<SopRule[]> {
    const rules: SopRule[] = [];
    const domainDirs = fs.readdirSync(dir, { withFileTypes: true });
    for (const dirent of domainDirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('_') || dirent.name.startsWith('.')) {
        continue;
      }
      const domain = dirent.name as GovernanceDomain;
      const domainPath = path.join(dir, domain);
      const actionDirs = fs.readdirSync(domainPath, { withFileTypes: true });
      for (const actionDirent of actionDirs) {
        if (!actionDirent.isDirectory() || actionDirent.name.startsWith('.')) continue;
        const action = actionDirent.name as ActionType;
        await this.collectRulesFromAction(path.join(domainPath, action), domain, action, rules);
      }
    }
    return rules;
  }

  private async collectRulesFromAction(
    actionPath: string,
    domain: GovernanceDomain,
    action: ActionType,
    rules: SopRule[],
  ): Promise<void> {
    for (const filePath of this.collectRuleFiles(actionPath)) {
      const rule = await this.parseRuleFile(filePath, domain, action);
      if (!rule) continue;
      rules.push(rule);
    }
  }

  private registerAll(rules: SopRule[], replaceAll: boolean): void {
    if (replaceAll) {
      this.registry.loadAll(rules);
      return;
    }
    for (const rule of rules) {
      try {
        this.registry.register(rule);
      } catch {
        this.registry.update(rule.id, rule);
      }
    }
  }

  /**
   * 收集目录下所有规则文件（递归支持子目录如 inspect/scan/typescript/）
   */
  private collectRuleFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return this.collectRuleFiles(fullPath);
      }
      if (entry.isFile() && RULE_FILE_EXT.test(entry.name)) {
        return [fullPath];
      }
      return [];
    });
  }

  private async parseRuleFile(
    filePath: string,
    domain: GovernanceDomain,
    action: ActionType,
  ): Promise<SopRule | null> {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const raw = await fs.promises.readFile(filePath, 'utf-8');

      let parsed: Record<string, unknown>;
      if (ext === '.json') {
        parsed = JSON.parse(raw);
      } else {
        const loaded = yaml.load(raw);
        if (!loaded || typeof loaded !== 'object') return null;
        parsed = loaded as Record<string, unknown>;
      }

      return this.buildRule(parsed, domain, action, filePath);
    } catch (err) {
      console.error(`[SopLoader] Failed to parse rule file: ${filePath}`, err);
      return null;
    }
  }

  private buildRule(
    parsed: Record<string, unknown>,
    domain: GovernanceDomain,
    action: ActionType,
    filePath: string,
  ): SopRule {
    const fileName = path.basename(filePath, path.extname(filePath));
    const meta = (parsed.metadata && typeof parsed.metadata === 'object')
      ? parsed.metadata as Record<string, unknown>
      : null;
    return meta
      ? this.buildWithMeta({ parsed, meta, domain, action, fileName })
      : this.buildSimple(parsed, domain, action, fileName);
  }

  private buildWithMeta({
    parsed,
    meta,
    domain,
    action,
    fileName,
  }: {
    parsed: Record<string, unknown>;
    meta: Record<string, unknown>;
    domain: GovernanceDomain;
    action: ActionType;
    fileName: string;
  }): SopRule {
    const gov = (parsed.governance && typeof parsed.governance === 'object')
      ? parsed.governance as Record<string, unknown>
      : {};
    const exec = (parsed.execution && typeof parsed.execution === 'object')
      ? parsed.execution as Record<string, unknown>
      : {};
    const judgment = (parsed.judgment && typeof parsed.judgment === 'object')
      ? parsed.judgment as Record<string, unknown>
      : {};

    const source = (meta.source as string) ?? 'official';
    const ruleId = (meta.id as string) ?? `${domain}.${action}.${source}.${fileName}`;
    const severity = this.priorityToSeverity(judgment.priority as string | undefined);

    return {
      id: ruleId,
      name: (meta.name as string) ?? fileName,
      domain: (gov.domain as GovernanceDomain) ?? domain,
      action: (gov.action as ActionType) ?? action,
      source: source as DataSource,
      description: (meta.description as string) ?? '',
      status: (meta.status as RuleLifecycleStatus) ?? 'draft',
      executionMode: (exec.mode as ExecutionMode) ?? 'sync',
      severity,
      applicableEngines: [gov.domain as string ?? domain],
      content: parsed,
      tags: (meta.tags as string[]) ?? [],
      serves: this.parseServes(parsed),
      falsePositiveCount: 0,
      truePositiveCount: 0,
      createdAt: meta.created ? new Date(meta.created as string) : new Date(),
      updatedAt: meta.updated ? new Date(meta.updated as string) : new Date(),
    };
  }

  private buildSimple(
    parsed: Record<string, unknown>,
    domain: GovernanceDomain,
    action: ActionType,
    fileName: string,
  ): SopRule {
    const source = (parsed.source as string) ?? 'official';
    const ruleId = `${domain}.${action}.${source}.${fileName}`;

    return {
      id: ruleId,
      name: (parsed.name as string) ?? fileName,
      domain,
      action,
      source: source as DataSource,
      description: (parsed.description as string) ?? '',
      status: (parsed.status as RuleLifecycleStatus) ?? 'draft',
      executionMode: (parsed.executionMode as ExecutionMode) ?? 'sync',
      severity: (parsed.severity as SopRule['severity']) ?? 'medium',
      applicableEngines: (parsed.applicableEngines as string[]) ?? [domain],
      content: parsed,
      tags: (parsed.tags as string[]) ?? [],
      serves: this.parseServes(parsed),
      falsePositiveCount: 0,
      truePositiveCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private priorityToSeverity(priority?: string): SopRule['severity'] {
    return PRIORITY_TO_SEVERITY.get(priority ?? '') ?? 'medium';
  }

  /** 从规则文件顶层 serves 声明解析能力声明，未声明或全部为空时返回 undefined */
  private parseServes(parsed: Record<string, unknown>): RuleServes | undefined {
    if (typeof parsed.serves !== 'object' || parsed.serves === null) return undefined;
    const raw = parsed.serves as Record<string, unknown>;
    const serves: RuleServes = {};
    for (const key of ['languages', 'productForms', 'architectures'] as const) {
      const value = raw[key];
      if (Array.isArray(value)) {
        const items = value.filter((v): v is string => typeof v === 'string');
        if (items.length > 0) serves[key] = items;
      }
    }
    return Object.keys(serves).length > 0 ? serves : undefined;
  }

  // ─── 从知识库加载 ──────────────────────────────────────────

  async loadFromKnowledgeBase(rules: SopRule[]): Promise<void> {
    for (const rule of rules) {
      try {
        this.registry.register(rule);
      } catch {
        // 已存在则更新
        this.registry.update(rule.id, rule);
      }
    }
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
