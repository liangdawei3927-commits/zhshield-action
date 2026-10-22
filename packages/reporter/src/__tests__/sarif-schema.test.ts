import { describe, it, expect } from 'vitest';
import { toSarif } from '../machine-formatters';
import type { Finding } from '../machine-formatters';

// toSarif 是 GitHub Code Scanning 上传链路的最后一环：SARIF 规范对 version/$schema、
// level 枚举、rules 表与 results 的一致性都有硬校验，任何一处不合法整份上传被拒，
// Security 面板直接断供。本文件守住「结构合法性」这一层契约。

/** SARIF 2.1.0 最小结构（仅覆盖本文件断言所需的字段） */
interface SarifLog {
  version: string;
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        rules: Array<{ id: string; shortDescription: { text: string } }>;
      };
    };
    results: Array<{
      ruleId: string;
      level: string;
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
          region: { startLine: number; startColumn: number };
        };
      }>;
    }>;
  }>;
}

function parseSarif(json: string): SarifLog {
  return JSON.parse(json) as SarifLog;
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    ruleId: 'r.default',
    severity: 'warning',
    message: '默认消息',
    source: 'guard',
    ...overrides,
  };
}

describe('toSarif — SARIF 2.1.0 结构合法性', () => {
  it('顶层 version/$schema 与 tool.driver.name 齐全，toolName 可自定义', () => {
    const sarif = parseSarif(toSarif([finding({})]));

    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('zhshield');
    expect(sarif.runs[0].tool.driver.informationUri).toContain('http');

    const custom = parseSarif(toSarif([], 'zhshield-nightly'));
    expect(custom.runs[0].tool.driver.name).toBe('zhshield-nightly');
  });

  it('level 映射合法：error→error，warning→warning，info→note（GitHub 合法枚举）', () => {
    const sarif = parseSarif(
      toSarif([
        finding({ ruleId: 'r.e', severity: 'error' }),
        finding({ ruleId: 'r.w', severity: 'warning' }),
        finding({ ruleId: 'r.i', severity: 'info' }),
      ]),
    );

    const levels = Object.fromEntries(sarif.runs[0].results.map((r) => [r.ruleId, r.level]));
    expect(levels['r.e']).toBe('error');
    expect(levels['r.w']).toBe('warning');
    expect(levels['r.i']).toBe('note'); // 'info' 不是 SARIF 合法 level
  });

  it('相同 ruleId 的多条 finding 在 rules 表去重，results 保持逐条输出', () => {
    const sarif = parseSarif(
      toSarif([
        finding({ ruleId: 'dup.rule', message: '第一条消息' }),
        finding({ ruleId: 'dup.rule', message: '第二条消息' }),
        finding({ ruleId: 'other.rule', message: '其他' }),
      ]),
    );

    expect(sarif.runs[0].tool.driver.rules.map((r) => r.id)).toEqual(['dup.rule', 'other.rule']);
    expect(sarif.runs[0].results).toHaveLength(3);
  });

  it('超长消息的 shortDescription 截断到 160 字符——GitHub 对描述长度有上限，超长会拖垮规则表', () => {
    const longMessage = 'x'.repeat(500);
    const sarif = parseSarif(toSarif([finding({ ruleId: 'r.long', message: longMessage })]));

    expect(longMessage.length).toBe(500);
    expect(sarif.runs[0].tool.driver.rules[0].shortDescription.text.length).toBe(160);
  });

  it('region 缺省行/列回退为 1——SARIF region 的 startLine/startColumn 为必填语义', () => {
    const sarif = parseSarif(toSarif([finding({ file: 'a.ts' })]));

    const region = sarif.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.startLine).toBe(1);
    expect(region.startColumn).toBe(1);
  });

  it('空 findings 产出 results/rules 均为空的合法 SARIF——全绿的流水线同样要能上传产物', () => {
    const sarif = parseSarif(toSarif([]));
    expect(sarif.runs[0].results).toHaveLength(0);
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(0);
  });
});
