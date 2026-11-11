/**
 * 单条 check 的检测结论类型。
 *
 * 独立成模块：扫描器（security-config-scan）与判定器（security-config-checks）都要
 * 引用它，若留在 SecurityCheckEngine 里会形成「引擎 → 判定器 → 引擎类型」的环。
 * 这里只放类型，无运行时代码。
 */

/** passed / failed（命中风险）/ error（检测执行异常），由 SecurityCheckEngine 转为 GuardEngine 契约 */
export interface SecurityCheckResult {
  status: 'passed' | 'failed' | 'error';
  message?: string;
  /**
   * 不适用标注：检测项在本项目**确实不存在可检对象**（如未使用 Web 框架时的
   * Helmet/CSRF 要求）。仅作为附加语义，status 仍为 passed —— 不新增顶层状态，
   * 避免破坏既有消费方（GuardEngine 契约、SARIF、评分）的 schema。
   *
   * 只在「确知不适用」处设置；无法判定时不得猜测（宁可保持 passed/failed 现状）。
   */
  applicability?: 'not-applicable';
}
