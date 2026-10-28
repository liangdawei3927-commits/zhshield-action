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
import {
  validateRuleSource,
  normalizeTags,
  logIssues,
  PRIORITY_CANDIDATES,
  type SopRuleIssue,
} from './sop-field-validation';

/** 预期缺失判定：ENOENT/ENOTDIR 属「文件不存在」的可恢复场景，与解析失败区分处理 */
function isNotFoundErr(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** 根节点必须是映射对象：排除 null / 数组 / 标量 */
function isObjectRoot(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * priority → severity 映射表。
 * 候选集来自 `PRIORITY_CANDIDATES`（与加载期校验共用一份白名单），
 * 避免「校验说合法、映射却认不出」的两套标准。
 */
const PRIORITY_TO_SEVERITY = new Map<string, SopRule['severity']>(
  PRIORITY_CANDIDATES.map((p) => [p, p as SopRule['severity']]),
);

/**
 * SOP 规则解析器 — 将单个规则文件内容解析/构建为 SopRule
 *
 * 职责：
 * 1. 读取并按扩展名解析规则文件（JSON / YAML）
 * 2. 解析错误分类处理（配置错误上抛，缺失/解析失败降级跳过）
 * 3. 依据 metadata / governance / execution / judgment 构建 SopRule
 */
export class SopRuleParser {
  /** 本次加载过程中发现的问题（fatal 已拒规则 / warn 已纠正），供诊断消费 */
  private issues: SopRuleIssue[] = [];

  /** 读取累计问题（只读视图） */
  getIssues(): readonly SopRuleIssue[] {
    return this.issues;
  }

  /** 清空问题累计 —— 每次整目录加载前调用，避免跨轮次叠加 */
  clearIssues(): void {
    this.issues = [];
  }

  async parseRuleFile(
    filePath: string,
    domain: GovernanceDomain,
    action: ActionType,
  ): Promise<SopRule | null> {
    try {
      const parsed = await this.readAndParseFile(filePath);
      if (parsed === null) return null;

      // 运行期白名单校验：拼错的枚举值必须在此拦下，否则规则会静默空跑
      const validation = validateRuleSource(parsed, domain, action, filePath);
      this.reportIssues(validation.issues);
      if (validation.drop) return null;

      const rule = this.buildRule(parsed, domain, action, filePath);
      return this.applyTagNormalization(rule, validation.issues);
    } catch (err) {
      return this.handleParseError(err, filePath);
    }
  }

  /**
   * 记录并打印一批校验问题 —— 文件加载与云端同步两条路径共用同一出口，
   * 保证「问题在哪都留痕」，而不是一条走 console、一条静默丢。
   */
  reportIssues(issues: readonly SopRuleIssue[]): void {
    if (issues.length === 0) return;
    this.issues.push(...issues);
    logIssues(issues);
  }

  /** tags 非法时用归一化结果替换，防止字符串/混合数组流入下游 tags.filter */
  private applyTagNormalization(rule: SopRule, issues: readonly SopRuleIssue[]): SopRule {
    const tagIssue = issues.find((i) => i.field === 'metadata.tags' || i.field === 'tags');
    return tagIssue ? { ...rule, tags: normalizeTags(tagIssue.value) } : rule;
  }

  /** 读取并按扩展名解析规则文件（JSON 或 YAML）；根不是对象时返回 null */
  private async readAndParseFile(filePath: string): Promise<Record<string, unknown> | null> {
    const ext = path.extname(filePath).toLowerCase();
    const raw = await fs.promises.readFile(filePath, 'utf-8');

    if (ext === '.json') {
      const parsed: unknown = JSON.parse(raw);
      // 原实现直接 `return JSON.parse(raw)`：根为 null 时 buildRule 抛 TypeError 被吞成
      // 「解析失败」；根为数组时更糟——所有字段 undefined，产出一条 id 取自文件名的空壳规则。
      if (!isObjectRoot(parsed)) {
        this.rejectNonObjectRoot(filePath, parsed);
        return null;
      }
      return parsed;
    }
    const loaded: unknown = yaml.load(raw);
    if (!isObjectRoot(loaded)) {
      this.rejectNonObjectRoot(filePath, loaded);
      return null;
    }
    return loaded;
  }

  /**
   * 根节点不是对象：记录问题并打印（不再静默跳过）。
   * 级别取 warn 而非 fatal —— 语义是「这个文件不是规则」可安全跳过，
   * 与文件缺失（ENOENT）同级；fatal 留给「是规则但字段非法」这类必须拒收的情况。
   */
  private rejectNonObjectRoot(filePath: string, value: unknown): void {
    const issue: SopRuleIssue = {
      file: filePath,
      field: '<root>',
      value,
      level: 'warn',
      reason: '规则文件根节点必须是对象（映射），当前为 null / 数组 / 标量，已跳过',
    };
    this.reportIssues([issue]);
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
