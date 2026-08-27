import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'production';
});

vi.mock('@nestjs/core', () => ({
  NestFactory: {
    create: vi.fn(async () => ({
      setGlobalPrefix: vi.fn(),
      useGlobalPipes: vi.fn(),
      enableCors: vi.fn(),
      listen: vi.fn(async () => {}),
    })),
  },
}));

vi.mock('./app.module', () => ({ AppModule: {} }));

import { resolveAllowedOrigins } from '../main';

describe('resolveAllowedOrigins（CORS 来源解析）', () => {
  it('缺省返回本地开发来源，绝不使用通配符 *', () => {
    expect(resolveAllowedOrigins({})).toEqual(['http://localhost:3010', 'http://127.0.0.1:3010']);
  });

  it('CORS_ORIGINS 逗号分隔解析并 trim', () => {
    expect(resolveAllowedOrigins({ CORS_ORIGINS: ' https://a.com , https://b.com ' })).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('空项被过滤', () => {
    expect(resolveAllowedOrigins({ CORS_ORIGINS: 'https://a.com,,, ' })).toEqual(['https://a.com']);
  });
});