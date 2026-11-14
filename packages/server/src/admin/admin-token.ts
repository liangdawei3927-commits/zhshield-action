import { constantTimeEqual } from '@zh/shared';

/**
 * 校验管理员令牌。
 *
 * 比较逻辑收敛到 `@zh/shared` 的 {@link constantTimeEqual}：此前 admin-token /
 * local-only.guard / sentinel.guard / sentinel alert-handler 各写一份，
 * 四处任一处被改写都不会有测试变红，只会让那个入口静默降级成普通比较。
 */
export function verifyAdminToken(token: string, expected: string): boolean {
  return constantTimeEqual(token, expected);
}
