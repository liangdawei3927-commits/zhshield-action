import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { LocalOnlyGuard, Public } from '../auth/local-only.guard';

/** 构造 guard 并读取构造时解析出的期望 token（来自 ~/.zhshield/.api-token 或降级随机值） */
function makeGuard(isPublic = false) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(isPublic) };
  const guard = new LocalOnlyGuard(reflector as never);
  const expectedToken = (guard as unknown as { expectedToken: string }).expectedToken;
  const makeContext = (opts: { ip?: string; token?: string } = {}) => {
    const request = {
      ip: opts.ip ?? '127.0.0.1',
      headers: opts.token !== undefined ? { 'x-api-token': opts.token } : {},
    };
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
  };
  return { guard, expectedToken, makeContext };
}

describe('LocalOnlyGuard', () => {
  it('@Public 标记的路由无条件放行（即使 IP 与 token 均无效）', () => {
    const { guard, makeContext } = makeGuard(true);
    expect(guard.canActivate(makeContext({ ip: '8.8.8.8', token: 'bad' }))).toBe(true);
  });

  it('非本地 IP 一律拒绝（即使 token 正确）', () => {
    const { guard, expectedToken, makeContext } = makeGuard();
    const ctx = makeContext({ ip: '192.168.1.50', token: expectedToken });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('IPv6 映射形式 ::ffff:127.0.0.1 视为本地', () => {
    const { guard, expectedToken, makeContext } = makeGuard();
    const ctx = makeContext({ ip: '::ffff:127.0.0.1', token: expectedToken });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('本地 IP + 正确 token 放行', () => {
    const { guard, expectedToken, makeContext } = makeGuard();
    expect(guard.canActivate(makeContext({ token: expectedToken }))).toBe(true);
  });

  it('缺失或错误的 token 被拒绝（timing-safe 比较路径）', () => {
    const missing = makeGuard();
    expect(() => missing.guard.canActivate(missing.makeContext({}))).toThrow(
      UnauthorizedException,
    );

    const wrong = makeGuard();
    expect(() => wrong.guard.canActivate(wrong.makeContext({ token: 'a'.repeat(64) }))).toThrow(
      UnauthorizedException,
    );
  });

  it('Public 装饰器导出契约稳定', () => {
    expect(Public).toBeTypeOf('function');
  });
});
