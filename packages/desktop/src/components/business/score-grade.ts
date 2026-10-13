/**
 * 评分等级 → 主题色（全仓唯一来源）。
 *
 * 阈值与 `@zh/scoring` 的 `gradeOf` 严格同源：
 * A>=90 success / B>=75 info / C>=60 warning / D<60 danger，
 * 保证评分环（HealthRing / ScoreRing）与等级徽章、报告表格取色一致。
 *
 * 调用方若需「未检测 / 无分」的中性灰，请在调用点自行判定 null 后回退
 * `rgb(var(--zh-muted))`，不要把 null 语义塞进本函数（本函数只处理已收敛到
 * [0,100] 的数值分；越界/NaN 按 D 处理，不会抛错）。
 */
export function getScoreColor(score: number): string {
  if (score >= 90) return 'rgb(var(--zh-success))';
  if (score >= 75) return 'rgb(var(--zh-info))';
  if (score >= 60) return 'rgb(var(--zh-warning))';
  return 'rgb(var(--zh-danger))';
}
