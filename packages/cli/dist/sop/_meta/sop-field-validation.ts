import {
  GOVERNANCE_DOMAINS,
  ACTION_TYPES,
  DATA_SOURCES,
  RULE_LIFECYCLE_STATUSES,
  SEVERITIES,
  sanitizeLogField,
} from '@zh/shared';
import type { GovernanceDomain, ActionType, SopRule } from './sop-types';
import { validateRuleContent } from './sop-content-validation';

/**
 * SOP 规则加载期字段校验 — 把「类型断言」换成「运行期白名单」。
 *
 * 背景（2026-10-29 实测）：`SopRuleParser` 原实现对枚举字段一律写
 * `meta.status as RuleLifecycleStatus`。类型断言在运行期不产生任何行为，于是
 * 云端下发一条 `status: actived`（拼错）会被原样接受：
 *   规则注册进 registry → 但不匹配任何生命周期 → `getActive()` 取不到它
 *   → 规则**永久静默空跑**，本地零告警。
 * 同类风险还有 `tags` 写成字符串（下游 `tags.filter` 直接抛）、
 * `governance.domain` 写非法值（绕过治理域白名单）。
 *
 * 处理分级：
 *   · fatal —— 显式声明但取值非法 ⇒ 拒绝该规则（保留它等于留一个永不执行的幽灵）
 *   · warn  —— 可纠正 ⇒ 保留规则但归一化，并记录问题供诊断
 * 缺失字段**不**计为问题：由 parser 的缺省值兜底，保持存量规则兼容。
 */

/** 单条校验问题的级别 */
export type SopRuleIssueLevel = 'fatal' | 'warn';

/** 一条加载期校验问题（供诊断面板 / 日志消费） */
export interface SopRuleIssue {
  /** 规则文件路径 */
  file: string;
  /** 出问题的字段路径，如 `metadata.status` */
  field: string;
  /** 原始取值 */
  value: unknown;
  /** 人可读的判定理由 */
  reason: string;
  /** 级别：fatal 已导致该规则被拒；warn 已自动纠正 */
  level: SopRuleIssueLevel;
}

/** 校验结论 */
export interface SopRuleValidation {
  issues: SopRuleIssue[];
  /** 是否应拒绝该规则（存在 fatal 级问题） */
  drop: boolean;
}

/** 单文件问题数上限：防止云端整批坏文件导致问题数组无界增长 */
export const MAX_ISSUES_PER_FILE = 20;

/** judgment.priority 的合法取值 —— 与 parser 的 priority→severity 映射表同源 */
export const PRIORITY_CANDIDATES: readonly string[] = SEVERITIES.filter((s) => s !== 'info');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 枚举字段校验：缺失（undefined/null）放行，显式声明则必须在白名单内。
 * 非字符串取值（数字、布尔、对象）一并判非法 —— 原实现会把它原样塞进 SopRule。
 */
function checkEnum(
  file: string,
  field: string,
  value: unknown,
  allowed: readonly string[],
  level: SopRuleIssueLevel = 'fatal',
): SopRuleIssue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && allowed.includes(value)) return null;
  return {
    file,
    field,
    value,
    level,
    reason: `取值 ${JSON.stringify(value)} 不在允许集合 {${allowed.join(' | ')}} 内`,
  };
}

/** tags 字段：必须是字符串数组；非数组或含非字符串项时按 warn 纠正 */
function checkTags(file: string, field: string, value: unknown): SopRuleIssue | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.every((t) => typeof t === 'string')) return null;
  return {
    file,
    field,
    value,
    level: 'warn',
    reason: '应为字符串数组，已丢弃非法取值（否则下游 tags.filter 会抛错）',
  };
}

/** 按 warn 问题的原始值归一化 tags：数组保留字符串项，其余一律空数组 */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === 'string');
}

/**
 * 单条校验问题的日志文本 —— 文件加载（parser）与云端同步（sync-coordinator）
 * 两条路径共用，避免各写一份格式而漂移。
 */
export function formatIssue(issue: SopRuleIssue): string {
  const value = JSON.stringify(issue.value) ?? String(issue.value);
  const head = issue.level === 'fatal' ? '规则被拒' : '字段已纠正';
  return `[SopLoader] ${head}: ${sanitizeLogField(issue.file)} ${issue.field}=${value} — ${issue.reason}`;
}

/**
 * 逐条打印校验问题：fatal 走 error、warn 走 warn。
 * 文件加载（parser）与云端同步（admission）共用 —— 两条路径各写一遍循环会漂移。
 */
export function logIssues(issues: readonly SopRuleIssue[]): void {
  for (const issue of issues) {
    const log = issue.level === 'fatal' ? console.error : console.warn;
    // 打单条消息而非 printf 多参：日志聚合器与测试断言都只认第一个参数
    log(formatIssue(issue));
  }
}

/**
 * 校验一份规则源对象的枚举字段。
 *
 * 判 fatal 的唯一口径：**这个字段错了会让规则永远调度不到**。
 * 实测消费点（`packages/kernel/src/runner.ts`）：
 *   · `status` —— `getActive()` 只取 `active`，拼错即永久空跑 ⇒ fatal
 *   · `domain` —— `runner.ts:103` 按域过滤，非法域匹配不到任何引擎 ⇒ fatal
 *   · `action` —— `runner.ts:106` 按动作过滤，同上 ⇒ fatal
 * 其余字段不参与「是否执行」的判定（`source` 只进索引与展示，`severity`
 * 只影响报告分级），一律 warn —— 拒掉它们等于白丢检出能力。
 *
 * @param parsed    YAML/JSON 解析后的根对象
 * @param dirDomain 目录推导出的治理域（`{dir}/{domain}/{action}/**`）
 * @param dirAction 目录推导出的动作类型
 * @param filePath  规则文件路径，仅用于问题定位
 */
export function validateRuleSource(
  parsed: Record<string, unknown>,
  dirDomain: GovernanceDomain,
  dirAction: ActionType,
  filePath: string,
): SopRuleValidation {
  const issues: SopRuleIssue[] = [];
  const push = (issue: SopRuleIssue | null): void => {
    if (issue && issues.length < MAX_ISSUES_PER_FILE) issues.push(issue);
  };

  const meta = isPlainObject(parsed.metadata) ? parsed.metadata : null;
  const gov = isPlainObject(parsed.governance) ? parsed.governance : null;
  const judgment = isPlainObject(parsed.judgment) ? parsed.judgment : null;

  if (meta) {
    // ─── 新格式：字段收在 metadata / governance / judgment 下 ───
    push(checkEnum(filePath, 'metadata.status', meta.status, RULE_LIFECYCLE_STATUSES));
    push(checkEnum(filePath, 'governance.domain', gov?.domain, GOVERNANCE_DOMAINS));
    push(checkEnum(filePath, 'governance.action', gov?.action, ACTION_TYPES));
    push(checkEnum(filePath, 'metadata.source', meta.source, DATA_SOURCES, 'warn'));
    push(checkTags(filePath, 'metadata.tags', meta.tags));

    // 优先级非法会让 severity 静默降为 medium —— 记警告，不拒绝（规则仍可执行）
    const priority = judgment?.priority;
    if (priority !== undefined && priority !== null) {
      const asString = typeof priority === 'string' ? priority : String(priority);
      if (!PRIORITY_CANDIDATES.includes(asString)) {
        push({
          file: filePath,
          field: 'judgment.priority',
          value: priority,
          level: 'warn',
          reason: `取值 ${JSON.stringify(priority)} 无法映射到 severity，已降级为 medium`,
        });
      }
    }
  } else {
    // ─── 简单格式：字段平铺在根对象上 ───
    push(checkEnum(filePath, 'status', parsed.status, RULE_LIFECYCLE_STATUSES));
    push(checkEnum(filePath, 'source', parsed.source, DATA_SOURCES, 'warn'));
    push(checkTags(filePath, 'tags', parsed.tags));
    // severity 不校验：存量 YAML 混用 Issue 侧语义（warning / deprecation / "P1"），
    // 且该字段不参与「规则是否执行」的判定，归一化应单独立项，不在加载器里武断改值。
  }

  // ─── 域/动作覆盖可见性：目录在 guard/ 却声明 security 域会把规则挪到别的治理域 ───
  // 这是 parser 的既有行为（governance 字段优先于目录推导），保留但必须留痕。
  const declaredDomain = gov?.domain;
  if (
    typeof declaredDomain === 'string' &&
    declaredDomain !== dirDomain &&
    (GOVERNANCE_DOMAINS as readonly string[]).includes(declaredDomain)
  ) {
    push({
      file: filePath,
      field: 'governance.domain',
      value: declaredDomain,
      level: 'warn',
      reason: `与目录推导域 "${dirDomain}" 不一致，规则将归属 "${declaredDomain}"`,
    });
  }

  const declaredAction = gov?.action;
  if (
    typeof declaredAction === 'string' &&
    declaredAction !== dirAction &&
    (ACTION_TYPES as readonly string[]).includes(declaredAction)
  ) {
    push({
      file: filePath,
      field: 'governance.action',
      value: declaredAction,
      level: 'warn',
      reason: `与目录推导动作 "${dirAction}" 不一致，规则将归属 "${declaredAction}"`,
    });
  }

  return { issues, drop: issues.some((i) => i.level === 'fatal') };
}

/**
 * 对象级校验：校验**已构建**的 `SopRule`（云端同步路径）。
 *
 * 为什么需要第二套：文件加载路径拿到的是带 `metadata/governance` 嵌套的源对象，
 * 走 `validateRuleSource`；而云端同步（`PipelineRunner` → `loadFromKnowledgeBase`）
 * 拿到的是**已构建的扁平 SopRule**，完全不经过 parser —— 这是风险最大的一条路
 * （内容由云端产出、本地无法预知），却恰恰是原实现**零校验**的一条。
 *
 * fatal 与 warn 的划分口径：会让规则「永久不执行」或「归错治理域」的字段判 fatal
 * （此时留它在 registry 里等于留一个永不触发的幽灵）；只影响展示或可安全降级的判 warn。
 *
 * @param origin 问题归因标识（云端用 `cloud-sync`，便于与文件路径区分）
 */
export function validateBuiltRule(rule: SopRule, origin: string): SopRuleIssue[] {
  const issues: SopRuleIssue[] = [];
  const push = (issue: SopRuleIssue | null): void => {
    if (issue && issues.length < MAX_ISSUES_PER_FILE) issues.push(issue);
  };
  const raw = rule as unknown as Record<string, unknown>;

  const id = raw.id;
  // 定位串必须带规则 id：云端一次下发几十条，只说「cloud-sync 拒了 3 条」无法排查
  const locator = `${origin}:${typeof id === 'string' && id.trim() !== '' ? id : '<no-id>'}`;

  if (typeof id !== 'string' || id.trim() === '') {
    push({
      file: locator,
      field: 'id',
      value: id,
      level: 'fatal',
      reason: 'id 必须是非空字符串（规则身份，缺失会导致后续覆盖/去重全部失效）',
    });
  }

  // 决定「能否被调度到」的字段：非法即永久空跑或归错域 ⇒ fatal
  push(checkEnum(locator, 'domain', raw.domain, GOVERNANCE_DOMAINS));
  push(checkEnum(locator, 'action', raw.action, ACTION_TYPES));
  push(checkEnum(locator, 'status', raw.status, RULE_LIFECYCLE_STATUSES));

  // 不参与「是否执行」判定 ⇒ warn（拒掉它们等于白丢检出能力）
  push(checkEnum(locator, 'source', raw.source, DATA_SOURCES, 'warn'));

  push(checkTags(locator, 'tags', raw.tags));

  // serves 是画像能力声明：结构坏了不致命（当前不参与调度），但必须可见
  const serves = raw.serves;
  if (serves !== undefined && serves !== null && !isPlainObject(serves)) {
    push({
      file: locator,
      field: 'serves',
      value: serves,
      level: 'warn',
      reason: '应为 { languages?, productForms?, architectures? } 对象，已忽略',
    });
  } else if (isPlainObject(serves)) {
    for (const key of ['languages', 'productForms', 'architectures'] as const) {
      const list = serves[key];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) {
        push({
          file: locator,
          field: `serves.${key}`,
          value: list,
          level: 'warn',
          reason: '应为字符串数组，已忽略该项',
        });
      }
    }
  }

  // content 段能否真跑起来 —— 元数据字段合法 ≠ 检查内容可执行。
  // 无执行段（unresolved）一律 fatal 拒收，不限生命周期状态：客户端是规则纯消费者，
  // 无执行段的规则永远零产出，拒收即清洗空壳（详见 sop-content-validation.ts 头注释）。
  // 阈值指标缺取数归属则 active fatal / 非 active warn（指标未接属正常草稿态，已 gate active 炸弹）。
  for (const issue of validateRuleContent(rule, locator)) push(issue);

  return issues;
}

/** 批量过滤云端规则：返回可接纳的规则与被拒规则的问题清单 */
export function filterBuiltRules(
  rules: readonly SopRule[],
  origin: string,
): { accepted: SopRule[]; issues: SopRuleIssue[] } {
  const accepted: SopRule[] = [];
  const issues: SopRuleIssue[] = [];
  for (const rule of rules) {
    const ruleIssues = validateBuiltRule(rule, origin);
    issues.push(...ruleIssues);
    if (ruleIssues.some((i) => i.level === 'fatal')) continue;
    const tagIssue = ruleIssues.find((i) => i.field === 'tags');
    accepted.push(tagIssue ? { ...rule, tags: normalizeTags(tagIssue.value) } : rule);
  }
  return { accepted, issues };
}
