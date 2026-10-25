import type { CodeSmell } from './types';

/**
 * 重构报告的文件级评分纯函数（单一来源）。
 *
 * 从 RefactorEngine 私有方法提取：引擎生成报告与基线过滤重建报告必须使用同一套
 * 公式，否则过滤后的 maintainabilityScore / refactorPriority 会与全量报告口径漂移。
 */

/** 按严重度加权扣分得出可维护性分（0-100），与 engine.calculateMaintainability 同式 */
export function calculateMaintainability(smells: CodeSmell[]): number {
  if (smells.length === 0) return 100;
  const weights = { error: 15, warning: 8, info: 3 };
  const totalWeight = smells.reduce((sum, s) => {
    const w = weights[s.severity as keyof typeof weights] || 3;
    return sum + w;
  }, 0);
  const score = 100 - totalWeight;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 按错误/警告数量得出重构优先级，与 engine.calculatePriority 同式 */
export function calculatePriority(smells: CodeSmell[]): 'critical' | 'high' | 'medium' | 'low' {
  const errorCount = smells.filter((s) => s.severity === 'error').length;
  const warningCount = smells.filter((s) => s.severity === 'warning').length;
  if (errorCount >= 3) return 'critical';
  if (errorCount >= 1 || warningCount >= 5) return 'high';
  if (warningCount >= 2) return 'medium';
  return 'low';
}
