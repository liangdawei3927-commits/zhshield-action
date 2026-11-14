/**
 * 总评等级（A/B/C/D）与分数↔等级换算 —— 全仓唯一阈值表。
 *
 * ## 为什么收敛到这里
 *
 * 「score ≥ 90 → A，≥ 75 → B，≥ 60 → C，否则 D」这套阈值此前全仓共 **5 份**：
 *
 *   · `@zh/scoring` `module-score.ts` 的 gradeOf
 *   · `@zh/scoring` `scoring-engine.ts` 的 toGrade
 *   · `@zh/scoring` `engine.ts` computeGrade 的内联三元
 *   · `@zh/inspect` `scan-report-builder.ts` 的 gradeOf
 *   · `@zh/shared` `dimension-mapper.ts` 里其实**早就有一份** scoreToGrade ——
 *     但没有任何包引用它，等于白放了一份；本次一并接到本文件
 *
 * 而且 `ScoreGrade` 这个类型也在 `@zh/scoring` 与 `@zh/inspect` 各定义了一次。
 *
 * 这是**面向用户的口径**：同一份分数，扫描页显示 B、报告中心显示 C，用户没法
 * 判断该信哪个。四处阈值只要有一处被单独调整，就会静默产生这种分叉 —— 不会
 * 报错，测试也未必覆盖到那个入口。
 *
 * 注意 `engine.ts` 的「短板封顶」（任一维 <75 则总评最高 B）用的是同一套边界值
 * 但语义不同，它取的是**上限**而非「分数落在哪档」，故仍留在原处，只复用本文件的
 * 等级次序 {@link GRADE_ORDER}。
 */

/** 总评等级：由 overall 分数映射的 A/B/C/D 四档 */
export type ScoreGrade = 'A' | 'B' | 'C' | 'D';

/** 等级由好到差：用于「取更差的那个」这类封顶运算，勿在别处另建映射 */
export const GRADE_ORDER: readonly ScoreGrade[] = ['A', 'B', 'C', 'D'] as const;

/**
 * 分数 → 等级。
 *
 * 边界含左端点（90 即 A、75 即 B、60 即 C），与原四处实现逐字等价。
 */
export function scoreToGrade(score: number): ScoreGrade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}
