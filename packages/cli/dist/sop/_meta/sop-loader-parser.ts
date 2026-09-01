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
} from './sop-types';
import { SopRuleConfigError, parseDynamicSeverityConfig } from './dynamic-severity-config';

/** 预期缺失判定：ENOENT/ENOTDIR 属「文件不存在」的可恢复场景，与解析失败区分处理 */
function isNotFoundErr(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** priority → severity 映射表（替代 priorityToSeverity 中的 switch 分派） */
const PRIORITY_TO_SEVERITY = new Map<string, SopRule['severity']>([
  ['critical', 'critical'],
  ['high', 'high'],
  ['medium', 'medium'],
  ['low', 'low'],
  ['error', 'error'],
]);

/**
 * SOP 规则解析器 — 将单个规则文件内容解析/构建为 SopRule
 *
 * 职责：
 * 1. 读取并按扩展名解析规则文件（JSON / YAML）
 * 2. 解析错误分类处理（配置错误上抛，缺失/解析失败降级跳过）
 * 3. 依据 metadata / governance / execution / judgment 构建 SopRule
 */
export class SopRuleParser {
  async parseRuleFile(
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
    const meta =
      parsed.metadata && typeof parsed.metadata === 'object'
        ? (parsed.metadata as Record<string, unknown>)
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
    const gov =
      parsed.governance && typeof parsed.governance === 'object'
        ? (parsed.governance as Record<string, unknown>)
        : {};
    const exec =
      parsed.execution && typeof parsed.execution === 'object'
        ? (parsed.execution as Record<string, unknown>)
        : {};
    const judgment =
      parsed.judgment && typeof parsed.judgment === 'object'
        ? (parsed.judgment as Record<string, unknown>)
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
      applicableEngines: [(gov.domain as string) ?? domain],
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
}
