import { describe, it, expect, expectTypeOf } from 'vitest';
import type { Issue, CodeFlow, CodeFlowThreadFlow, CodeFlowLocation } from '../index';

/** 最小合法 Issue：新字段全可选，现有消费者不带新字段也必须合法 */
function baseIssue(): Issue {
  return {
    id: 'i-1',
    ruleId: 'no-var',
    severity: 'warning',
    category: 'quality',
    message: 'Use let/const',
    file: 'src/app.ts',
    line: 10,
    column: 5,
    autoFixable: true,
    source: 'inspect',
    fingerprint: 'no-var:src/app.ts:10',
  };
}

describe('Issue 可选扩展字段（§11.3 / ADR #1 内部规范形态）', () => {
  it('Given 最小必填字段 Issue，When 构造后访问新字段，Then 均为 undefined（零破坏）', () => {
    const issue = baseIssue();

    expect(issue.codeFlows).toBeUndefined();
    expect(issue.stack).toBeUndefined();
    expect(issue.taxonomies).toBeUndefined();
  });

  it('Given SARIF-compatible 污点链，When 挂载 codeFlows，Then 完整保留 source→sink 位置链', () => {
    const codeFlows: CodeFlow[] = [
      {
        threadFlows: [
          {
            locations: [
              { location: { file: 'src/a.py', line: 1, column: 2 }, message: 'taint source' },
              { location: { file: 'src/a.py', line: 5, column: 1 }, message: 'taint sink' },
            ],
          },
        ],
      },
    ];

    const issue: Issue = { ...baseIssue(), codeFlows };

    expect(issue.codeFlows).toHaveLength(1);
    expect(issue.codeFlows![0].threadFlows[0].locations).toHaveLength(2);
    expect(issue.codeFlows![0].threadFlows[0].locations[0].location).toEqual({
      file: 'src/a.py',
      line: 1,
      column: 2,
    });
    expect(issue.codeFlows![0].threadFlows[0].locations[1].message).toBe('taint sink');
  });

  it('Given 栈追踪行数组，When 挂载 stack，Then 逐行保留', () => {
    const stack = ['at fn (src/a.ts:1:1)', 'at main (src/index.ts:10:1)'];
    const issue: Issue = { ...baseIssue(), stack };

    expect(issue.stack).toEqual(stack);
  });

  it('Given 分类标签，When 挂载 taxonomies，Then 保留（如 validation:NO_VALIDATOR）', () => {
    const taxonomies = ['validation:NO_VALIDATOR', 'sca:reachable'];
    const issue: Issue = { ...baseIssue(), taxonomies };

    expect(issue.taxonomies).toEqual(taxonomies);
  });

  it('Given 位置缺省 line/column，When 构造 CodeFlowLocation，Then 合法（SARIF 兼容）', () => {
    const location: CodeFlowLocation = { location: { file: 'src/a.py' } };

    expect(location.location.line).toBeUndefined();
    expect(location.location.column).toBeUndefined();
  });
});

describe('Issue 可选扩展字段类型断言（typecheck 阶段生效）', () => {
  it('codeFlows/stack/taxonomies 均为全可选字段', () => {
    expectTypeOf<Issue['codeFlows']>().toEqualTypeOf<CodeFlow[] | undefined>();
    expectTypeOf<Issue['stack']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<Issue['taxonomies']>().toEqualTypeOf<string[] | undefined>();
  });

  it('CodeFlow 形状与 SARIF 子集一致且不含 any', () => {
    expectTypeOf<CodeFlow>().toEqualTypeOf<{ threadFlows: CodeFlowThreadFlow[] }>();
    expectTypeOf<CodeFlowThreadFlow>().toEqualTypeOf<{ locations: CodeFlowLocation[] }>();
    expectTypeOf<CodeFlowLocation['location']>().toEqualTypeOf<{
      file: string;
      line?: number;
      column?: number;
    }>();
  });

  it('不带新字段的 Issue 依然可赋值为 Issue', () => {
    const minimal: Issue = baseIssue();
    expectTypeOf(minimal).toEqualTypeOf<Issue>();
  });
});
