import { describe, it, expect } from 'vitest';
import { sanitizeEnv } from '../process-env';

describe('sanitizeEnv', () => {
  it('should keep base runtime variables', () => {
    const env = sanitizeEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/test',
      LANG: 'zh_CN.UTF-8',
    });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/Users/test');
    expect(env.LANG).toBe('zh_CN.UTF-8');
  });

  it('should drop sensitive variables', () => {
    const env = sanitizeEnv({
      PATH: '/usr/bin',
      MY_API_TOKEN: 'abc',
      AWS_SECRET_ACCESS_KEY: 'xyz',
      NPM_TOKEN: 'nt-123',
      GH_TOKEN: 'ghp-456',
      SSH_AUTH_SOCK: '/tmp/ssh.sock',
      PATH2: undefined,
    });
    expect(env.MY_API_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it('should keep allowed business prefixes', () => {
    const env = sanitizeEnv({
      PATH: '/usr/bin',
      npm_config_registry: 'https://registry.npmjs.org/',
      NODE_ENV: 'production',
      ZH_API_BASE: 'http://localhost:3010/api/v1',
    });
    expect(env.npm_config_registry).toBe('https://registry.npmjs.org/');
    expect(env.NODE_ENV).toBe('production');
    expect(env.ZH_API_BASE).toBe('http://localhost:3010/api/v1');
  });

  it('should strip sensitive keys even under allowed prefixes', () => {
    const env = sanitizeEnv({
      PATH: '/usr/bin',
      npm_config__authToken: 'secret-registry-token',
      NODE_OPTIONS: '--max-old-space-size=4096',
    });
    expect(env.npm_config__authToken).toBeUndefined();
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
  });

  it('should apply overrides last', () => {
    const env = sanitizeEnv({ PATH: '/usr/bin' }, { CI: 'true' });
    expect(env.CI).toBe('true');
  });

  it('should not mutate the original env object', () => {
    const original = { PATH: '/usr/bin', MY_API_TOKEN: 'abc' };
    const env = sanitizeEnv(original);
    expect(original.MY_API_TOKEN).toBe('abc');
    expect(env.MY_API_TOKEN).toBeUndefined();
  });
});
