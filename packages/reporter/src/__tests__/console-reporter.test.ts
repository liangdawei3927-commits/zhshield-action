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
        {
          id: 'v1',
          ruleId: 'guard.block.sensitive-info',
          severity: 'critical',
          file: 'src/config.ts',
          line: 5,
          message: '匹配到 API Key',
          suggestion: '使用环境变量',
          category: 'security',
        },
        {
          id: 'v2',
          ruleId: 'guard.block.sensitive-info',
          severity: 'high',
          file: 'src/utils.ts',
          line: 12,
          message: '匹配到密码',
          suggestion: '移除硬编码',
          category: 'security',
        },
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
          rule: {
            ...evaluation.rule,
            id: 'inspect.scan.complexity',
            severity: 'medium',
            domain: 'inspect',
            applicableEngines: ['inspect'],
          },
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
      total: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
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
        {
          id: 'p1',
          ruleId: 'e18e/prefer-array-at',
          severity: 'medium',
          file: 'src/App.tsx',
          line: 42,
          message: '使用 .at() 代替下标访问',
          category: 'performance',
        },
        {
          id: 'p2',
          ruleId: 'e18e/prefer-includes',
          severity: 'low',
          file: 'src/utils.ts',
          line: 7,
          message: '使用 .includes() 代替 indexOf',
          category: 'performance',
        },
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
      message:
        '所有扫描器不可用: semgrep(未安装或在 PATH 中未找到), gitleaks(未注册工具适配器: gitleaks)',
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

  // ─── 工具可用性矩阵 ──────────────────────────────────

  it('9. format: 含 unavailable adapterResult 时输出工具不可用告警', () => {
    const report: PipelineReport = {
      timestamp: new Date(),
      guard: null,
      inspect: {
        projectId: 'test',
        timestamp: new Date(),
        scanType: 'full',
        duration: 100,
        score: { overall: 85, grade: 'B' },
        issues: [],
        summary: { total: 0, error: 0, warning: 0, info: 0 },
        adapterResults: [
          {
            adapterId: 'semgrep',
            adapterName: 'semgrep',
            duration: 2100,
            issueCount: 3,
            passed: true,
            status: 'passed',
            issues: [],
          },
          {
            adapterId: 'gitleaks',
            adapterName: 'gitleaks',
            duration: 0,
            issueCount: 0,
            passed: false,
            status: 'unavailable',
            issues: [],
          },
          {
            adapterId: 'trivy',
            adapterName: 'trivy',
            duration: 0,
            issueCount: 0,
            passed: false,
            status: 'unavailable',
            issues: [],
          },
        ],
        recommendations: [],
      },
      passed: true,
      stage: 'complete',
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.format(report);

    expect(result.text).toContain('工具不可用');
    expect(result.text).toContain('gitleaks');
    expect(result.text).toContain('trivy');
    expect(result.text).toContain('未安装');
    expect(result.text).toContain('⚠');
  });

  it('10. format: 全部 passed 的 adapterResults 输出工具行且无告警', () => {
    const report: PipelineReport = {
      timestamp: new Date(),
      guard: null,
      inspect: {
        projectId: 'test',
        timestamp: new Date(),
        scanType: 'full',
        duration: 100,
        score: { overall: 90, grade: 'A' },
        issues: [],
        summary: { total: 0, error: 0, warning: 0, info: 0 },
        adapterResults: [
          {
            adapterId: 'semgrep',
            adapterName: 'semgrep',
            duration: 2100,
            issueCount: 3,
            passed: true,
            status: 'passed',
            issues: [],
          },
          {
            adapterId: 'eslint',
            adapterName: 'eslint',
            duration: 300,
            issueCount: 1,
            passed: true,
            status: 'passed',
            issues: [],
          },
        ],
        recommendations: [],
      },
      passed: true,
      stage: 'complete',
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.format(report);

    expect(result.text).toContain('工具');
    expect(result.text).toContain('semgrep');
    expect(result.text).toContain('eslint');
    expect(result.text).not.toContain('不可用');
    expect(result.text).not.toContain('⚠');
  });

  it('11. format: skipped adapterResults 显示真实原因，不再一律"语言不适用"（P2）', () => {
    const report: PipelineReport = {
      timestamp: new Date(),
      guard: null,
      inspect: {
        projectId: 'test',
        timestamp: new Date(),
        scanType: 'full',
        duration: 100,
        score: { overall: 90, grade: 'A' },
        issues: [],
        summary: { total: 0, error: 0, warning: 0, info: 0 },
        adapterResults: [
          {
            adapterId: 'semgrep',
            adapterName: 'semgrep',
            duration: 0,
            issueCount: 0,
            passed: true,
            status: 'skipped',
            skipDetail: 'Semgrep 规则目录不存在，请先同步云脑规则',
            issues: [],
          },
          {
            adapterId: 'eslint',
            adapterName: 'eslint',
            duration: 0,
            issueCount: 0,
            passed: true,
            status: 'skipped',
            skipReason: 'out-of-scope',
            issues: [],
          },
          {
            adapterId: 'ts-prune',
            adapterName: 'ts-prune',
            duration: 0,
            issueCount: 0,
            passed: true,
            status: 'skipped',
            issues: [],
          },
        ],
        recommendations: [],
      },
      passed: true,
      stage: 'complete',
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.format(report);

    expect(result.text).toContain('已跳过');
    expect(result.text).toContain('Semgrep 规则目录不存在，请先同步云脑规则');
    expect(result.text).toContain('画像裁剪');
    expect(result.text).not.toContain('语言不适用');
  });

  it('12. format: error/failed 且 issueCount>0 归入"检出问题"，不再误报"工具执行失败"', () => {
    const report: PipelineReport = {
      timestamp: new Date(),
      guard: null,
      inspect: {
        projectId: 'test',
        timestamp: new Date(),
        scanType: 'full',
        duration: 100,
        score: { overall: 60, grade: 'C' },
        issues: [],
        summary: { total: 4, error: 4, warning: 0, info: 0 },
        adapterResults: [
          {
            adapterId: 'dep-cruiser',
            adapterName: '循环依赖检测',
            duration: 1200,
            issueCount: 1,
            passed: false,
            status: 'error',
            issues: [],
          },
          {
            adapterId: 'tsc',
            adapterName: 'TypeScript 类型错误检查（真 tsc）',
            duration: 600,
            issueCount: 2,
            passed: false,
            status: 'failed',
            issues: [],
          },
          {
            adapterId: 'gitleaks',
            adapterName: '硬编码密钥/凭证检测',
            duration: 2500,
            issueCount: 1,
            passed: false,
            status: 'error',
            issues: [],
          },
        ],
        recommendations: [],
      },
      passed: true,
      stage: 'complete',
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.format(report);

    expect(result.text).toContain('⚠ 检出 4 个问题');
    expect(result.text).toContain('循环依赖检测(1)');
    expect(result.text).toContain('TypeScript 类型错误检查（真 tsc）(2)');
    expect(result.text).toContain('硬编码密钥/凭证检测(1)');
    expect(result.text).not.toContain('✗ 工具执行失败');
  });

  it('13. format: error/failed 且 issueCount===0 保留"工具执行失败"（真失败）', () => {
    const report: PipelineReport = {
      timestamp: new Date(),
      guard: null,
      inspect: {
        projectId: 'test',
        timestamp: new Date(),
        scanType: 'full',
        duration: 100,
        score: { overall: 100, grade: 'A' },
        issues: [],
        summary: { total: 0, error: 0, warning: 0, info: 0 },
        adapterResults: [
          {
            adapterId: 'dep-cruiser',
            adapterName: '循环依赖检测',
            duration: 1200,
            issueCount: 0,
            passed: false,
            status: 'error',
            issues: [],
          },
          {
            adapterId: 'tsc',
            adapterName: 'TypeScript 类型错误检查（真 tsc）',
            duration: 600,
            issueCount: 0,
            passed: false,
            status: 'failed',
            issues: [],
          },
        ],
        recommendations: [],
      },
      passed: true,
      stage: 'complete',
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.format(report);

    expect(result.text).toContain('✗ 工具执行失败');
    expect(result.text).toContain('循环依赖检测');
    expect(result.text).toContain('TypeScript 类型错误检查（真 tsc）');
    expect(result.text).not.toContain('⚠ 检出');
  });

  // ─── 豁免清单审计：休眠/过期条目可见性 ──────────────

  it('休眠与过期豁免条目须显式列出——否则豁免清单会静默虚增成仪式', () => {
    const report: PipelineReport = {
      timestamp: new Date(),
      guard: {
        ok: true,
        summary: { total: 0, passed: 0, failed: 0 },
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
        score: { overall: 100, grade: 'A' },
        issues: [],
        summary: { total: 0, error: 0, warning: 0, info: 0 },
        adapterResults: [],
        recommendations: [],
        suppressedIssues: [],
        dormantEntries: [
          {
            ruleId: 'inspect.scan.depcruiser.circular-dependency',
            file: 'packages/kernel/src/backup/local-backup.ts',
            line: 0,
            column: 0,
            owner: 'arch',
            expiresAt: '2027-01-01T00:00:00.000Z',
          },
        ],
        expiredEntries: [
          { ruleId: 'inspect.scan.stale.thing', file: 'src/old.ts', line: 3, column: 1 },
        ],
      },
      passed: true,
      stage: 'complete',
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.format(report);

    expect(result.text).toContain('豁免清单待复核');
    expect(result.text).toContain('inspect.scan.depcruiser.circular-dependency');
    expect(result.text).toContain('本轮未命中');
    expect(result.text).toContain('arch');
    expect(result.text).toContain('inspect.scan.stale.thing');
    expect(result.text).toContain('已过期');
  });

  it('清单干净时不得产出审计噪音——休眠与过期均为 0 时整段不出现', () => {
    const report: PipelineReport = {
      timestamp: new Date(),
      guard: {
        ok: true,
        summary: { total: 0, passed: 0, failed: 0 },
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
        score: { overall: 100, grade: 'A' },
        issues: [],
        summary: { total: 0, error: 0, warning: 0, info: 0 },
        adapterResults: [],
        recommendations: [],
        suppressedIssues: [],
        dormantEntries: [],
        expiredEntries: [],
      },
      passed: true,
      stage: 'complete',
    };

    const reporter = new ConsoleReporter({ color: false });
    const result = reporter.format(report);

    expect(result.text).not.toContain('豁免清单待复核');
  });
});
