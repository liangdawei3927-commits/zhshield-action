/**
 * 各域结论快照（《07》O8 / C3「只读复用」的输入契约）。
 *
 * 门禁是**纯判定**域：不调用任何扫描器，只读其它域已产出的结论并判 pass/fail。
 * 本文件定义「结论快照」的形状与「供应商域」的解析规则，让调用方（pipeline /
 * desktop）把结论注入门禁，而不是让门禁自己去跑 eslint / gitleaks / trivy。
 *
 * 关键约束：
 *   · 结论只由 Owner 域自己产出（C1）；门禁拿到的只是它的只读副本。
 *   · 缺结论（供应商域本次未运行）→ 门禁跳过该项，**不得判通过**（C4）。
 *   · `toolError` 条目是 Owner 域的工具执行失败，不是代码问题，门禁不得据此判失败。
 */
import type { IssueSeverity } from '../types';
import { findToolCapability } from './capability-registry';
import { resolveOwnerId } from './ownership-registry';
import type { DomainId } from './types';

/** 一条只读结论（Owner 域报告中的问题条目，字段与 `DomainIssue` 对齐） */
export interface ConclusionIssue {
  ruleId: string;
  severity: IssueSeverity;
  /** 相对项目根的文件路径 */
  file: string;
  line?: number;
  column?: number;
  message: string;
  suggestion?: string;
  /** Owner 域标记的工具执行失败条目：不是代码问题，门禁不得据此判定失败 */
  toolError?: boolean;
}

/** 单一域的结论快照 */
export interface DomainConclusion {
  domain: DomainId;
  /** 快照生成时间（ISO）；门禁在消息里回显，便于用户判断结论新鲜度 */
  generatedAt: string;
  issues: readonly ConclusionIssue[];
}

/** 各域结论集合：缺省某域 = 该域本次未运行（门禁据此跳过，而不是判通过） */
export type DomainConclusionSet = Partial<Record<DomainId, DomainConclusion>>;

/**
 * 解析某工具结论的供应商域（C1 单一来源）。
 *
 * 优先查工具能力表（`TOOL_CAPABILITIES` 的 ruleFamilies.owner），
 * 能力表未登记时回退归属注册表的 token 匹配；都查不到返回 null（调用方据此跳过）。
 */
export function resolveSupplierDomain(tool: string): DomainId | null {
  const capability = findToolCapability(tool as Parameters<typeof findToolCapability>[0]);
  if (capability) return capability.ruleFamilies[0]?.owner ?? null;
  return resolveOwnerId(tool);
}
