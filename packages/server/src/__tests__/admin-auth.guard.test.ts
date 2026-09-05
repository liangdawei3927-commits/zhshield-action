import { describe, expect, it, afterEach, vi } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';

function makeContext(token?: string) {
  const request = {
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe('AdminAuthGuard（C4 管理接口鉴权）', () => {
  const original = process.env.ZH_ADMIN_TOKEN;

  afterEach(() => {
    if (original === undefined) delete process.env.ZH_ADMIN_TOKEN;
    else process.env.ZH_ADMIN_TOKEN = original;
    vi.restoreAllMocks();
  });

  it('ZH_ADMIN_TOKEN 未配置 → 503 ServiceUnavailableException', () => {
    delete process.env.ZH_ADMIN_TOKEN;
    const guard = new AdminAuthGuard();
    expect(() => guard.canActivate(makeContext('anything'))).toThrow(ServiceUnavailableException);
  });

  it('正确 Bearer token 放行', () => {
    process.env.ZH_ADMIN_TOKEN = 'secret-token';
    const guard = new AdminAuthGuard();
    expect(guard.canActivate(makeContext('secret-token'))).toBe(true);
  });

  it('错误 token → 401 UnauthorizedException', () => {
    process.env.ZH_ADMIN_TOKEN = 'secret-token';
    const guard = new AdminAuthGuard();
    expect(() => guard.canActivate(makeContext('wrong-token'))).toThrow(UnauthorizedException);
  });

  it('缺失 Authorization 头 → 401', () => {
    process.env.ZH_ADMIN_TOKEN = 'secret-token';
    const guard = new AdminAuthGuard();
    expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
  });

  it('非 Bearer scheme → 401', () => {
    process.env.ZH_ADMIN_TOKEN = 'secret-token';
    const guard = new AdminAuthGuard();
    const request = { headers: { authorization: 'Basic abc' } };
    const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as never;
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});