import { describe, it, expect } from 'vitest';
import { ConsoleReporter } from '../console-reporter';
import type { PipelineReport } from '@zh/pipeline';
import type { RuleEngineReport, RuleEvaluation } from '@zh/kernel';

describe('ConsoleReporter — 报告格式化', () => {
  // ─── PipelineReport 格式化 ────────────────────────────

  it('1. format(PipelineReport): 正常流水线输出包含关键段落', () => {
    const report: PipelineReport = {
      timestamp: new Date('2026-07-29T10:00:00Z'),
      guard: {
        ok: true,
        summary: { total: 3, passed: 2, failed: 1 },
        mode: 'guard',
        target: '/tmp',
        timestamp: new Date(),
        results: [],
      },
      inspect: {
        projectId: 'test',
        timestamp: new Date(),
        scanType: 'full',
        duration: 100,
        score: { overall: 85, grade: 'B' },
        issues: [],
        summary: { total: 5, error: 1, warning: 3, info: 1 },
        adapterResults: [],
        recommendations: [],
      },
      passed: true,
      stage: 'complete',
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.format(report);

    expect(result.passed).toBe(true);
    expect(result.text).toContain('智汇码盾');
    expect(result.text).toContain('Guard 门禁检查');
    expect(result.text).toContain('Inspect 巡检');
    expect(result.text).toContain('流水线通过');
    expect(result.text).toContain('3'); // 3 项检查
    expect(result.text).toContain('5'); // 5 个问题
  });

  it('2. format(PipelineReport): 失败流水线输出失败信息', () => {
    const report: PipelineReport = {
      timestamp: new Date(),
      guard: {
        ok: false,
        summary: { total: 2, passed: 0, failed: 2 },
        mode: 'guard',
        target: '/tmp',
        timestamp: new Date(),
        results: [],
      },
      inspect: null,
      passed: false,
      stage: 'guard',
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.format(report);

    expect(result.passed).toBe(false);
    expect(result.text).toContain('失败');
    expect(result.text).toContain('Guard');
    expect(result.text).toContain('(未执行)'); // Inspect 段显示未执行
  });

  // ─── RuleEngineReport 格式化 ──────────────────────────

  it('3. formatRuleEngine: SOP 驱动模式报告', () => {
    const evaluation: RuleEvaluation = {
      rule: {
        id: 'guard.block.sensitive-info',
        name: '敏感信息检测',
        domain: 'guard',
        action: 'block',
        source: 'official',
        description: '',
        status: 'active',
        executionMode: 'sync',
        severity: 'critical',
        applicableEngines: ['guard'],
        content: {},
        tags: [],
        falsePositiveCount: 0,
        truePositiveCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      status: 'failed',
      message: '发现 2 处匹配',
      violations: [
        { id: 'v1', ruleId: 'guard.block.sensitive-info', severity: 'critical', file: 'src/config.ts', line: 5, message: '匹配到 API Key', suggestion: '使用环境变量', category: 'security' },
        { id: 'v2', ruleId: 'guard.block.sensitive-info', severity: 'high', file: 'src/utils.ts', line: 12, message: '匹配到密码', suggestion: '移除硬编码', category: 'security' },
      ],
      files: ['src/config.ts', 'src/utils.ts'],
      durationMs: 15,
      targetEngine: 'guard',
      timestamp: new Date(),
    };

    const report: RuleEngineReport = {
      total: 3,
      passed: 1,
      failed: 1,
      errors: 0,
      skipped: 1,
      ok: false,
      evaluations: [
        evaluation,
        {
          rule: { ...evaluation.rule, id: 'guard.pass.some', severity: 'low' },
          status: 'passed',
          durationMs: 3,
          targetEngine: 'guard',
          timestamp: new Date(),
        },
        {
          rule: { ...evaluation.rule, id: 'inspect.scan.complexity', severity: 'medium', domain: 'inspect', applicableEngines: ['inspect'] },
          status: 'skipped',
          message: 'InspectEngine 未注册',
          durationMs: 0,
          targetEngine: 'inspect',
          timestamp: new Date(),
        },
      ],
      durationMs: 50,
      timestamp: new Date(),
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.formatRuleEngine(report);

    expect(result.passed).toBe(false);
    expect(result.text).toContain('SOP 规则引擎报告');
    expect(result.text).toContain('guard.block.sensitive-info');
    expect(result.text).toContain('guard.pass.some');
    expect(result.text).toContain('API Key');
    expect(result.text).toContain('src/config.ts:5');
    expect(result.text).toContain('使用环境变量');
    expect(result.text).toContain('3 条规则');
    // 分类汇总行应包含 security 维度
    expect(result.text).toContain('分类:');
    expect(result.text).toContain('security');
    // 每条违规应带 [security] 标签
    expect(result.text).toContain('[security]');
  });

  // ─── 空报告 ──────────────────────────────────────────

  it('4. 空规则引擎报告', () => {
    const report: RuleEngineReport = {
      total: 0, passed: 0, failed: 0, errors: 0, skipped: 0,
      ok: true,
      evaluations: [],
      durationMs: 0,
      timestamp: new Date(),
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.formatRuleEngine(report);

    expect(result.passed).toBe(true);
    expect(result.text).toContain('0 条规则');
    expect(result.text).toContain('通过');
  });

  // ─── 错误报告 ─────────────────────────────────────────

  it('5. 流水线错误报告', () => {
    const report: PipelineReport = {
      timestamp: new Date(),
      guard: null,
      inspect: null,
      refactor: null,
      passed: false,
      stage: 'complete',
      error: 'GuardEngine 初始化失败',
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.format(report);

    expect(result.passed).toBe(false);
    expect(result.text).toContain('GuardEngine 初始化失败');
  });

  // ─── 颜色启停 ─────────────────────────────────────────

  it('6. color=false 时不包含 ANSI 转义码', () => {
    const report: PipelineReport = {
      timestamp: new Date(),
      guard: null,
      inspect: null,
      refactor: null,
      passed: true,
      stage: 'complete',
    };

    const colored = new ConsoleReporter({ color: true }).format(report);
    const plain = new ConsoleReporter({ color: false }).format(report);

    expect(colored.text).toContain('\x1b[');
    expect(plain.text).not.toContain('\x1b[');
  });

  // ─── 性能维度可见性 ────────────────────────────────────

  it('7. formatRuleEngine: performance 维度在分类汇总与违规标签中可见', () => {
    const perfEvaluation: RuleEvaluation = {
      rule: {
        id: 'inspect.scan.performance.eslint',
        name: 'ESLint 性能检测',
        domain: 'inspect',
        action: 'scan',
        source: 'official',
        description: '',
        status: 'active',
        executionMode: 'sync',
        severity: 'medium',
        applicableEngines: ['inspect'],
        content: {},
        tags: [],
        falsePositiveCount: 0,
        truePositiveCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      status: 'failed',
      message: '发现 2 处性能问题',
      violations: [
        { id: 'p1', ruleId: 'e18e/prefer-array-at', severity: 'medium', file: 'src/App.tsx', line: 42, message: '使用 .at() 代替下标访问', category: 'performance' },
        { id: 'p2', ruleId: 'e18e/prefer-includes', severity: 'low', file: 'src/utils.ts', line: 7, message: '使用 .includes() 代替 indexOf', category: 'performance' },
      ],
      files: ['src/App.tsx', 'src/utils.ts'],
      durationMs: 30,
      targetEngine: 'inspect',
      timestamp: new Date(),
    };

    const report: RuleEngineReport = {
      total: 1,
      passed: 0,
      failed: 1,
      errors: 0,
      skipped: 0,
      ok: false,
      evaluations: [perfEvaluation],
      durationMs: 30,
      timestamp: new Date(),
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.formatRuleEngine(report);

    // 分类汇总行应包含 performance 维度及计数
    expect(result.text).toContain('分类:');
    expect(result.text).toContain('performance');
    expect(result.text).toContain('2'); // 2 个 performance 问题
    // 每条违规应带 [performance] 标签
    expect(result.text).toContain('[performance]');
    expect(result.text).toContain('使用 .at() 代替下标访问');
    expect(result.text).toContain('src/App.tsx:42');
  });

  // ─── 跳过规则明细可见性 ────────────────────────────────

  it('8. formatRuleEngine: skipped 规则逐条明细可见（工具未安装可观测）', () => {
    const skippedEval: RuleEvaluation = {
      rule: {
        id: 'inspect.scan.security.semgrep',
        name: 'Semgrep 扫描',
        domain: 'inspect',
        action: 'scan',
        source: 'official',
        description: '',
        status: 'active',
        executionMode: 'sync',
        severity: 'medium',
        applicableEngines: ['inspect'],
        content: {},
        tags: [],
        falsePositiveCount: 0,
        truePositiveCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      status: 'skipped',
      message: '所有扫描器不可用: semgrep(未安装或在 PATH 中未找到), gitleaks(未注册工具适配器: gitleaks)',
      durationMs: 0,
      targetEngine: 'inspect',
      timestamp: new Date(),
    };

    const report: RuleEngineReport = {
      total: 1,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 1,
      ok: true,
      evaluations: [skippedEval],
      durationMs: 5,
      timestamp: new Date(),
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.formatRuleEngine(report);

    expect(result.text).toContain('跳过规则:');
    expect(result.text).toContain('inspect.scan.security.semgrep');
    expect(result.text).toContain('所有扫描器不可用');
    expect(result.text).toContain('semgrep');
    expect(result.text).toContain('gitleaks');
  });
});
