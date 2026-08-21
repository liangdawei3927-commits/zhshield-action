import { describe, it, expect } from 'vitest';
import { RuleEngineReportFormatter, severityLabel } from '../rule-engine-formatter';
import { ConsoleColor } from '../console-color';
import type { RuleEngineReport, RuleEvaluation } from '@zh/kernel';

// ─── 测试辅助 ──────────────────────────────────────────

function makeTt(): (key: string, params?: Record<string, unknown>) => string {
  return (key: string, params?: Record<string, unknown>): string => {
    const dict: Record<string, string> = {
      'reporter.summary': '汇总',
      'reporter.ruleCount': `${params?.count ?? 0} 条规则`,
      'reporter.passed': '通过',
      'reporter.failed': '失败',
      'reporter.errors': '错误',
      'reporter.skipped': '跳过',
      'reporter.duration': `耗时 ${params?.duration ?? 0}ms`,
      'reporter.category': '分类',
      'reporter.failedRules': '失败规则',
      'reporter.errorRules': '错误规则',
      'reporter.passedRules': '通过规则',
      'reporter.noMatchingRules': '未找到匹配规则',
      'reporter.andMore': `还有 ${params?.count ?? 0} 条`,
      'reporter.filesInvolved': `${params?.count ?? 0} 个文件`,
      'reporter.suggestion': '建议:',
      'severity.critical': '严重',
      'severity.high': '高',
      'severity.medium': '中',
      'severity.low': '低',
      'severity.info': '信息',
    };
    return dict[key] ?? key;
  };
}

function makeFormatter(color = false): RuleEngineReportFormatter {
  return new RuleEngineReportFormatter(new ConsoleColor(color), makeTt());
}

function makeRule(id: string, severity = 'medium') {
  return {
    id,
    name: id,
    domain: 'guard',
    action: 'scan',
    source: 'official',
    description: '',
    status: 'active' as const,
    executionMode: 'sync' as const,
    severity,
    applicableEngines: ['guard'],
    content: {},
    tags: [],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeEvaluation(overrides: Partial<RuleEvaluation>): RuleEvaluation {
  return {
    rule: makeRule('test-rule'),
    status: 'passed',
    durationMs: 5,
    targetEngine: 'guard',
    timestamp: new Date(),
    ...overrides,
  } as RuleEvaluation;
}

// ─── 测试 ──────────────────────────────────────────────

describe('RuleEngineReportFormatter — 规则引擎报告格式化', () => {
  it('1. format(): 汇总行包含规则数量', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 5, passed: 3, failed: 1, errors: 1, skipped: 0,
      ok: false,
      evaluations: [],
      durationMs: 100,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('5');
    expect(text).toContain('汇总');
  });

  it('2. format(): 显示通过/失败/错误/跳过计数', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 10, passed: 6, failed: 2, errors: 1, skipped: 1,
      ok: false,
      evaluations: [],
      durationMs: 50,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('6');  // passed
    expect(text).toContain('2');  // failed
    expect(text).toContain('1');  // errors
    expect(text).toContain('1');  // skipped
    expect(text).toContain('通过');
    expect(text).toContain('失败');
    expect(text).toContain('错误');
    expect(text).toContain('跳过');
  });

  it('3. format(): 显示耗时', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 1, passed: 1, failed: 0, errors: 0, skipped: 0,
      ok: true,
      evaluations: [],
      durationMs: 250,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('250');
    expect(text).toContain('耗时');
  });

  // ─── 空报告 ──────────────────────────────────────────

  it('4. format(): 空报告显示无匹配规则', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 0, passed: 0, failed: 0, errors: 0, skipped: 0,
      ok: true,
      evaluations: [],
      durationMs: 0,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('未找到匹配规则');
  });

  // ─── 分类汇总 ────────────────────────────────────────

  it('5. format(): 分类汇总显示违规类别', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 2, passed: 0, failed: 2, errors: 0, skipped: 0,
      ok: false,
      evaluations: [
        makeEvaluation({
          status: 'failed',
          violations: [
            { id: 'v1', ruleId: 'r1', severity: 'high', file: 'a.ts', message: 'issue1', category: 'security' },
            { id: 'v2', ruleId: 'r1', severity: 'medium', file: 'b.ts', message: 'issue2', category: 'security' },
            { id: 'v3', ruleId: 'r2', severity: 'low', file: 'c.ts', message: 'issue3', category: 'quality' },
          ],
        }),
        makeEvaluation({
          rule: makeRule('r2'),
          status: 'failed',
          violations: [
            { id: 'v4', ruleId: 'r2', severity: 'low', file: 'c.ts', message: 'issue4', category: 'quality' },
          ],
        }),
      ],
      durationMs: 20,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('分类');
    expect(text).toContain('security');
    expect(text).toContain('quality');
  });

  // ─── 失败规则详情 ─────────────────────────────────────

  it('6. format(): 失败规则显示标题和违规', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 1, passed: 0, failed: 1, errors: 0, skipped: 0,
      ok: false,
      evaluations: [
        makeEvaluation({
          status: 'failed',
          message: '发现 3 处问题',
          violations: [
            { id: 'v1', ruleId: 'r1', severity: 'critical', file: 'src/app.ts', line: 10, message: 'Critical bug', suggestion: 'Fix it', category: 'security' },
          ],
          files: ['src/app.ts'],
        }),
      ],
      durationMs: 30,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('失败规则');
    expect(text).toContain('发现 3 处问题');
    expect(text).toContain('src/app.ts:10');
    expect(text).toContain('Critical bug');
    expect(text).toContain('Fix it');
    expect(text).toContain('[security]');
  });

  // ─── 错误规则 ────────────────────────────────────────

  it('7. format(): 错误规则显示警告信息', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 1, passed: 0, failed: 0, errors: 1, skipped: 0,
      ok: false,
      evaluations: [
        makeEvaluation({
          status: 'error',
          message: '规则执行超时',
        }),
      ],
      durationMs: 50,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('错误规则');
    expect(text).toContain('⚠');
    expect(text).toContain('规则执行超时');
  });

  // ─── 通过规则 ────────────────────────────────────────

  it('8. format(): 通过规则显示 ✓ 标记', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 2, passed: 2, failed: 0, errors: 0, skipped: 0,
      ok: true,
      evaluations: [
        makeEvaluation({ status: 'passed', message: '检查通过' }),
        makeEvaluation({ rule: makeRule('r2'), status: 'passed' }),
      ],
      durationMs: 10,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('通过规则');
    expect(text).toContain('✓');
    expect(text).toContain('test-rule');
    expect(text).toContain('检查通过');
  });

  // ─── 缩进 ────────────────────────────────────────────

  it('9. format(): 输出行带有缩进', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 0, passed: 0, failed: 0, errors: 0, skipped: 0,
      ok: true,
      evaluations: [],
      durationMs: 0,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '  ' });

    const text = lines.join('\n');
    // Summary line should start with indent
    expect(text).toMatch(/^ {2}/);
  });

  // ─── 违规截断 ────────────────────────────────────────

  it('10. format(): 超过 10 条违规时显示还有更多', () => {
    const violations = Array.from({ length: 15 }, (_, i) => ({
      id: `v${i}`,
      ruleId: 'r1',
      severity: 'low' as const,
      file: `src/file${i}.ts`,
      message: `issue ${i}`,
    }));

    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 1, passed: 0, failed: 1, errors: 0, skipped: 0,
      ok: false,
      evaluations: [
        makeEvaluation({
          status: 'failed',
          violations,
        }),
      ],
      durationMs: 20,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('还有 5 条');
  });

  // ─── 无违规的失败规则 ─────────────────────────────────

  it('11. format(): 无违规的失败规则正常渲染', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 1, passed: 0, failed: 1, errors: 0, skipped: 0,
      ok: false,
      evaluations: [
        makeEvaluation({
          status: 'failed',
          message: 'Failed but no violations listed',
        }),
      ],
      durationMs: 10,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('Failed but no violations listed');
  });

  // ─── 文件列表 ────────────────────────────────────────

  it('12. format(): 失败规则显示涉及文件数', () => {
    const formatter = makeFormatter();
    const lines: string[] = [];
    const report: RuleEngineReport = {
      total: 1, passed: 0, failed: 1, errors: 0, skipped: 0,
      ok: false,
      evaluations: [
        makeEvaluation({
          status: 'failed',
          files: ['a.ts', 'b.ts', 'c.ts'],
          violations: [],
        }),
      ],
      durationMs: 10,
      timestamp: new Date(),
    };

    formatter.format({ report, lines, indent: '' });

    const text = lines.join('\n');
    expect(text).toContain('3 个文件');
  });
});

// ─── severityLabel 单元测试 ────────────────────────────

describe('severityLabel — 严重等级标签', () => {
  const tt = makeTt();

  it('1. 已知等级映射为中文标签', () => {
    expect(severityLabel('critical', tt)).toBe('严重');
    expect(severityLabel('high', tt)).toBe('高');
    expect(severityLabel('medium', tt)).toBe('中');
    expect(severityLabel('low', tt)).toBe('低');
    expect(severityLabel('info', tt)).toBe('信息');
  });

  it('2. 未知等级原样返回', () => {
    expect(severityLabel('unknown', tt)).toBe('unknown');
    expect(severityLabel('blocker', tt)).toBe('blocker');
  });
});
