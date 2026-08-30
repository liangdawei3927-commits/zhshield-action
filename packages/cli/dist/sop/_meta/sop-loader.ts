import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { sanitizeLogField } from '@zh/shared';
import type {
  SopRule,
  SopServes,
  GovernanceDomain,
  ActionType,
  DataSource,
  RuleLifecycleStatus,
  ExecutionMode,
  ProjectFeature,
} from './sop-types';
import { SopRegistry } from './sop-registry';
import { SopRuleConfigError, parseDynamicSeverityConfig } from './dynamic-severity-config';

const RULE_FILE_EXT = /\.(yml|yaml|json)$/i;

/** 预期缺失判定：ENOENT/ENOTDIR 属「文件不存在」的可恢复场景，与解析失败区分处理 */
function isNotFoundErr(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** 六大治理域目录 — collectRulesFromTree 只扫描这些一级目录，
 *  presets / tool-packs / cache / sync 等非域目录不作为规则来源加载 */
const GOVERNANCE_DOMAIN_DIRS = new Set<string>([
  'guard',
  'inspect',
  'security',
  'sentinel',
  'evolve',
  'refactor',
]);

/** priority → severity 映射表（替代 priorityToSeverity 中的 switch 分派） */
const PRIORITY_TO_SEVERITY = new Map<string, SopRule['severity']>([
  ['critical', 'critical'],
  ['high', 'high'],
  ['medium', 'medium'],
  ['low', 'low'],
  ['error', 'error'],
]);

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
 */
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
      if (!GOVERNANCE_DOMAIN_DIRS.has(dirent.name)) {
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
      if (this.registry.has(rule.id)) {
        this.registry.update(rule.id, rule);
      } else {
        this.registry.register(rule);
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
      const parsed = await this.readAndParseFile(filePath);
      if (parsed === null) return null;
      return this.buildRule(parsed, domain, action, filePath);
    } catch (err) {
      return this.handleParseError(err, filePath);
    }
  }

  /** 读取并按扩展名解析规则文件（JSON 或 YAML）；无对象根时返回 null */
  private async readAndParseFile(filePath: string): Promise<Record<string, unknown> | null> {
    const ext = path.extname(filePath).toLowerCase();
    const raw = await fs.promises.readFile(filePath, 'utf-8');

    if (ext === '.json') {
      return JSON.parse(raw);
    }
    const loaded = yaml.load(raw);
    if (!loaded || typeof loaded !== 'object') {
      console.warn(`[SopLoader] Rule file has no object root, skipped: ${filePath}`);
      return null;
    }
    return loaded as Record<string, unknown>;
  }

  /** 解析错误分类处理：配置错误必须上抛，文件缺失/解析失败降级为跳过 */
  private handleParseError(err: unknown, filePath: string): SopRule | null {
    if (err instanceof SopRuleConfigError) {
      throw err;
    }
    if (isNotFoundErr(err)) {
      console.warn(`[SopLoader] Rule file not found, skipped: ${filePath}`);
      return null;
    }
    console.error('[SopLoader] Failed to parse rule file: %s', sanitizeLogField(filePath), err);
    return null;
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
    const rule = meta
      ? this.buildWithMeta({ parsed, meta, domain, action, fileName })
      : this.buildSimple(parsed, domain, action, fileName);
    const serves = this.parseServes(parsed.serves);
    return serves ? { ...rule, serves } : rule;
  }

  /** 解析规则文件顶层 serves 声明（语言/产品形态/架构），空声明返回 undefined */
  private parseServes(value: unknown): SopServes | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const readStrings = (key: string): string[] | undefined => {
      const list = raw[key];
      if (!Array.isArray(list)) return undefined;
      const items = list.filter((item): item is string => typeof item === 'string');
      return items.length > 0 ? items : undefined;
    };
    const languages = readStrings('languages');
    const productForms = readStrings('productForms');
    const architectures = readStrings('architectures');
    if (!languages && !productForms && !architectures) return undefined;

    const serves: SopServes = {};
    if (languages) serves.languages = languages;
    if (productForms) serves.productForms = productForms;
    if (architectures) serves.architectures = architectures;
    return serves;
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
      falsePositiveCount: 0,
      truePositiveCount: 0,
      createdAt: meta.created ? new Date(meta.created as string) : new Date(),
      updatedAt: meta.updated ? new Date(meta.updated as string) : new Date(),
      ...parseDynamicSeverityConfig(parsed, severity, ruleId),
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
    const severity = (parsed.severity as SopRule['severity']) ?? 'medium';

    return {
      id: ruleId,
      name: (parsed.name as string) ?? fileName,
      domain,
      action,
      source: source as DataSource,
      description: (parsed.description as string) ?? '',
      status: (parsed.status as RuleLifecycleStatus) ?? 'draft',
      executionMode: (parsed.executionMode as ExecutionMode) ?? 'sync',
      severity,
      applicableEngines: (parsed.applicableEngines as string[]) ?? [domain],
      content: parsed,
      tags: (parsed.tags as string[]) ?? [],
      falsePositiveCount: 0,
      truePositiveCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...parseDynamicSeverityConfig(parsed, severity, ruleId),
    };
  }

  private priorityToSeverity(priority?: string): SopRule['severity'] {
    return PRIORITY_TO_SEVERITY.get(priority ?? '') ?? 'medium';
  }

  // ─── 从知识库加载 ──────────────────────────────────────────

  async loadFromKnowledgeBase(rules: SopRule[]): Promise<void> {
    for (const rule of rules) {
      if (this.registry.has(rule.id)) {
        // 已存在则更新
        this.registry.update(rule.id, rule);
      } else {
        this.registry.register(rule);
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
