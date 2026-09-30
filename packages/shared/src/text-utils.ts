/**
 * 转义正则特殊字符，使输入作为字面量参与匹配（而非被解释为元字符）。
 *
 * 收敛自三处逐字重复实现：
 * - dependency/adapters/typosquat-detector.ts（投毒名比对）
 * - dependency/adapters/upgrade-evaluator.ts（升级候选匹配）
 * - kernel/runner/scan-utils.ts（层名 / 模式字面量匹配）
 *
 * 输入均按不可信外部数据（包名、配置层名、扫描规则）处理。
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}