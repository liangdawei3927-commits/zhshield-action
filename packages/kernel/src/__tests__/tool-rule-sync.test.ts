import { describe, expect, it } from 'vitest';
import { hashToolRuleFiles, buildDefaultToolRuleConfigs } from '../sop/sync/tool-rule-sync';
import { resolveApiBase, resolveSopBase } from '../sop/sync/api-base';

const HEX64 = /^[0-9a-f]{64}$/;

describe('api-base', () => {
  it('strips trailing slashes', () => {
    expect(resolveApiBase('http://localhost:3010/api/v1/')).toBe('http://localhost:3010/api/v1');
  });

  it('builds sop base without duplicating /sop', () => {
    expect(resolveSopBase('http://localhost:3010/api/v1')).toBe('http://localhost:3010/api/v1/sop');
    expect(resolveSopBase('http://localhost:3010/api/v1/sop')).toBe('http://localhost:3010/api/v1/sop');
  });
});

describe('hashToolRuleFiles', () => {
  it('is order-independent for same files', () => {
    const a = hashToolRuleFiles([
      { filename: 'b.yml', content: 'b' },
      { filename: 'a.yml', content: 'a' },
    ]);
    const b = hashToolRuleFiles([
      { filename: 'a.yml', content: 'a' },
      { filename: 'b.yml', content: 'b' },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(HEX64);
  });

  it('changes when content changes', () => {
    const a = hashToolRuleFiles([{ filename: 'a.yml', content: 'x' }]);
    const b = hashToolRuleFiles([{ filename: 'a.yml', content: 'y' }]);
    expect(a).not.toBe(b);
  });
});

describe('buildDefaultToolRuleConfigs', () => {
  it('points all tools at the given API base', () => {
    const configs = buildDefaultToolRuleConfigs('http://localhost:3010/api/v1');
    expect(configs).toHaveLength(4);
    for (const cfg of configs) {
      expect(cfg.remoteVersionUrl).toContain('http://localhost:3010/api/v1/rules/');
      expect(cfg.remoteDownloadUrl).toContain('/download');
    }
  });
});
