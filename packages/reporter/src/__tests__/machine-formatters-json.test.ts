import { describe, it, expect } from 'vitest';
import { formatReportJson } from '../machine-formatters';

// formatReportJson 供 CI 产物与人工排查消费：缩进格式是人工 diff 的可读性底线，
// 内容保真是「机器输出与引擎产出一致」的信任基础——任何静默改写都会误导排障。

describe('formatReportJson — 报告 JSON 序列化', () => {
  it('输出带 2 空格缩进的格式化 JSON——一行式 JSON 会让人工排查在终端里不可读', () => {
    const report = { guard: { results: [] }, passed: true };
    const json = formatReportJson(report);

    expect(json).toBe(JSON.stringify(report, null, 2));
    expect(json).toContain('\n  "guard"');
  });

  it('内容保真：解析后与原报告深等值，嵌套数组/对象不丢不失真', () => {
    const report = {
      stage: 'complete',
      inspect: { issues: [{ ruleId: 'r1', file: 'a.ts', line: 3 }] },
      nested: { deep: { count: 2 } },
    };
    const parsed = JSON.parse(formatReportJson(report)) as typeof report;

    expect(parsed).toEqual(report);
  });

  it('null 报告序列化为字符串 "null" 而非抛异常——空输入不应让落盘链路崩溃', () => {
    expect(formatReportJson(null)).toBe('null');
  });

  it('undefined 报告必须返回 string（与 null 同兜底为 "null"）——JSON.stringify 对 undefined 原生返回 undefined，透传给 writeFileSync 会直接 TypeError 崩溃', () => {
    const result: unknown = formatReportJson(undefined);
    expect(typeof result).toBe('string');
    expect(result).toBe('null');
  });
});
