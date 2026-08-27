import { describe, it, expect } from 'vitest';
import { matchGlobPath } from '../scope-matcher';

describe('matchGlobPath', () => {
  it.each([
    ['**/*.{env,ts,js,json,yaml,yml}', 'src/app.ts', true],
    ['**/*.{env,ts,js,json,yaml,yml}', '.env', true],
    ['**/*.{env,ts,js,json,yaml,yml}', 'config/settings.yaml', true],
    ['**/*.{env,ts,js,json,yaml,yml}', 'src/app.py', false],
    ['**/*.{env,ts,js,json,yaml,yml}', '/abs/repo/src/a.json', true],
    ['**/node_modules/**', 'node_modules/pkg/index.js', true],
    ['**/node_modules/**', 'a/node_modules/pkg/index.js', true],
    ['**/node_modules/**', 'src/index.js', false],
    ['src/**', 'src/a/b.ts', true],
    ['src/**', 'lib/a.ts', false],
    ['*.ts', 'deep/nested/a.ts', true],
    ['*.ts', 'a.js', false],
    ['tsconfig?.json', 'tsconfig.json', false],
    ['tsconfig?.json', 'tsconfigs.json', true],
    ['**/*.test.ts', 'src/a.test.ts', true],
    ['**/*.test.ts', 'src/a.ts', false],
  ])('pattern %s vs %s → %s', (pattern, file, expected) => {
    expect(matchGlobPath(file, pattern)).toBe(expected);
  });

  it('normalizes windows separators and ./ prefixes deterministically', () => {
    expect(matchGlobPath('src\\app.ts', '**/*.ts')).toBe(true);
    expect(matchGlobPath('./src/app.ts', 'src/*.ts')).toBe(true);
    expect(matchGlobPath('/repo/node_modules/x.js', '**/node_modules/**')).toBe(true);
  });

  it('非法字符 glob（含正则元字符）被拒绝：快速返回 false，不挂起', { timeout: 1000 }, () => {
    expect(matchGlobPath('src/app.ts', '(a+)+$')).toBe(false);
    expect(matchGlobPath('src/app.ts', 'src/**[a-z')).toBe(false);
  });

  it('超长 glob 被拒绝：快速返回 false，不挂起', { timeout: 1000 }, () => {
    expect(matchGlobPath('src/app.ts', `src/${'a'.repeat(600)}`)).toBe(false);
  });

  it('合法 glob 行为保持（含 ? 与 {} 分支）', () => {
    expect(matchGlobPath('tsconfigs.json', 'tsconfig?.json')).toBe(true);
    expect(matchGlobPath('src/app.ts', '**/*.{ts,js}')).toBe(true);
  });
});
