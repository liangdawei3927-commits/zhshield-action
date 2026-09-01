import { describe, it, expect } from 'vitest';
import { toSarif } from '../machine-formatters';
import type { Finding } from '../machine-formatters';

// GitHub Code Scanning 对 location 是硬性要求：任何一个 result 缺少 locations，
// 整份 SARIF 会被拒绝（"expected at least one location"），导致 Security 面板
// 上传失败、门禁工作流标红。这里守住「每个 result 都必须有 location」这一约束。
describe('toSarif', () => {
  it('带文件的 finding 生成精确物理定位', () => {
    const findings: Finding[] = [
      {
        ruleId: 'no-secret',
        severity: 'error',
        message: '发现硬编码密钥',
        file: 'src/config.ts',
        line: 12,
        column: 3,
        source: 'guard',
      },
    ];
    const sarif = JSON.parse(toSarif(findings));
    const [loc] = sarif.runs[0].results[0].locations;
    expect(loc.physicalLocation.artifactLocation.uri).toBe('src/config.ts');
    expect(loc.physicalLocation.region.startLine).toBe(12);
  });

  it('无文件的 finding 回退到占位路径，保证 result 不缺 locations', () => {
    const findings: Finding[] = [
      {
        ruleId: 'no-lockfile',
        severity: 'warning',
        message: '缺少 lockfile',
        source: 'guard',
      },
    ];
    const sarif = JSON.parse(toSarif(findings));
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(1);
    expect(results[0].locations).toBeDefined();
    expect(results[0].locations.length).toBeGreaterThanOrEqual(1);
    expect(results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('unknown');
    expect(results[0].locations[0].physicalLocation.region.startLine).toBe(1);
  });
});
