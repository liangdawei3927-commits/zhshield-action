import * as crypto from 'node:crypto';

/** 常量时间比较令牌（sha256 摘要 + timingSafeEqual，防时序侧信道） */
export function verifyAdminToken(token: string, expected: string): boolean {
  if (!token || !expected) return false;
  try {
    const left = crypto.createHash('sha256').update(token).digest();
    const right = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}