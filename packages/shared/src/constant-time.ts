/**
 * 常量时间令牌比较（防时序侧信道）。
 *
 * ## 为什么集中到这里
 *
 * 同一段「sha256 两侧摘要 + timingSafeEqual」曾在四处各写一份：
 *
 *   · `@zh/server` `admin/admin-token.ts` 的 verifyAdminToken
 *   · `@zh/server` `auth/local-only.guard.ts` 的 verifyToken
 *   · `@zh/server` `sentinel/sentinel.guard.ts` 的 canActivate 内联
 *   · `@zh/sentinel` `alert-handler.ts` 的 verifyToken
 *
 * 这类重复比其他重复更值得收敛：四处比对的是「谁能拿到管理员/Webhook 权限」，
 * 一旦某处被单独「优化」成 `a === b`，或漏了空字符串判断，**不会报错、不会
 * 有测试变红**，只会让那一个入口悄悄变回可被计时试探的普通比较。收敛后
 * 判据只有一处，改错也只需要在一处修。
 *
 * ## 实现要点
 *
 * ① 先各自 sha256 再比较：`timingSafeEqual` 要求两侧等长，直接比原文会在
 *    长度不同时抛异常 —— 抛不抛本身就是一个泄漏位。摘要恒为 32 字节，抹平长度。
 * ② 空值直接返回 false：空 token 不得与「未配置的期望值」判等（否则未配置
 *    环境变量时任何人都能通过）。
 * ③ 包 try/catch：crypto 在极端环境（如 FIPS 模式禁用某些算法）可能抛错，
 *    安全比较失败必须**失败关闭**，不能把异常抛给调用方当成「通过」。
 */
import * as crypto from 'node:crypto';

/**
 * 常量时间比较两个令牌是否相等。
 *
 * @param actual 请求携带的令牌
 * @param expected 服务端期望的令牌
 * @returns 相等返回 true；任一为空、或比较过程异常，均返回 false
 */
export function constantTimeEqual(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  try {
    const left = crypto.createHash('sha256').update(actual).digest();
    const right = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}
