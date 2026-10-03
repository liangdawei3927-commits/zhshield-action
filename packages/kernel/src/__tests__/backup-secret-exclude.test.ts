import { describe, expect, it } from 'vitest';
import { matchesExcludePattern } from '../backup/utils';
import { DEFAULT_SECRET_EXCLUDE_PATTERNS, defaultBackupConfig } from '../backup/types';

const SECRETS = DEFAULT_SECRET_EXCLUDE_PATTERNS;

describe('matchesExcludePattern：既有三种形式不得回归', () => {
  it('目录形式：顶层与嵌套均命中', () => {
    expect(matchesExcludePattern('node_modules/x/y.js', ['node_modules/'])).toBe(true);
    expect(matchesExcludePattern('packages/a/node_modules/y.js', ['node_modules/'])).toBe(true);
  });

  it('后缀形式 *.ext：任意深度命中', () => {
    expect(matchesExcludePattern('a/b/app.log', ['*.log'])).toBe(true);
    expect(matchesExcludePattern('app.log', ['*.log'])).toBe(true);
  });

  it('兜底精确相等：仅命中完全相同路径', () => {
    expect(matchesExcludePattern('.npmrc', ['.npmrc'])).toBe(true);
    expect(matchesExcludePattern('a/.npmrc', ['.npmrc'])).toBe(false);
  });
});

describe('matchesExcludePattern：新增 basename 前缀形式（凭据排除的安全边界）', () => {
  it('.env* 覆盖任意深度的 .env 与 .env.*', () => {
    for (const p of ['.env', '.env.local', '.env.production', 'a/b/.env', 'packages/x/.env']) {
      expect(matchesExcludePattern(p, ['.env*']), `${p} 应被排除`).toBe(true);
    }
  });

  it('不误伤相似但无关的文件名', () => {
expect(matchesExcludePattern('src/environment.ts', ['.env*'])).toBe(false);
expect(matchesExcludePattern('docs/env.md', ['.env*'])).toBe(false);
expect(matchesExcludePattern('src/dotenv.ts', ['.env*'])).toBe(false);
});

  it('刻意过度排除 .envrc 一类文件：安全方向宁多勿漏', () => {
    // direnv 的 .envrc 常见 `export SECRET=...`，与 .env 同属凭据载体；
    // 前缀匹配会一并排除，这是有意的 fail-safe（漏排密钥的后果远大于多排一个文件）
    expect(matchesExcludePattern('docs/.envrc', ['.env*'])).toBe(true);
  });

  it('仅尾缀 * 的模式仍走原有 *. 分支语义（不被新分支劫持）', () => {
    expect(matchesExcludePattern('a/b.pem', ['*.pem'])).toBe(true);
    expect(matchesExcludePattern('a/b.pemx', ['*.pem'])).toBe(false);
  });
});

describe('默认配置必须排除凭据文件（一次点击即复制出项目）', () => {
  const configs = [defaultBackupConfig('/proj', 'demo'), defaultBackupConfig('/proj')];

  it.each(configs)('local 与 github 两侧都带凭据排除项', (cfg) => {
    for (const patterns of [cfg.local.excludePatterns, cfg.github.excludePatterns]) {
      for (const secret of SECRETS) {
        expect(patterns, `${secret} 缺失`).toContain(secret);
      }
    }
  });

  it.each(configs)('实际路径被真实排除逻辑命中', (cfg) => {
    const risky = [
      '.env',
      'apps/api/.env.production',
      'certs/server.pem',
      'keys/private.key',
      'id_rsa',
      '.npmrc',
    ];
    for (const p of risky) {
      expect(
        matchesExcludePattern(p, cfg.local.excludePatterns),
        `local 未排除 ${p}`,
      ).toBe(true);
      expect(
        matchesExcludePattern(p, cfg.github.excludePatterns),
        `github 未排除 ${p}`,
      ).toBe(true);
    }
  });

  it.each(configs)('仍保留既有非凭据排除项', (cfg) => {
    expect(cfg.local.excludePatterns).toContain('node_modules/');
    expect(cfg.local.excludePatterns).toContain('coverage/');
    expect(cfg.github.excludePatterns).toContain('*.log');
  });
});