import { describe, it, expect } from 'vitest';
import { toSarif, buildFindings } from '../machine-formatters';
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

// 复查4 P0 回归门禁：降级跳过必须出现在 findings 中——
// 此前 SARIF 0 results、无 skipped、无原因，CI 消费链路对"什么都没查"完全失明。
describe('buildFindings — 降级跳过可见性（复查4 P0）', () => {
  it('Given RuleEngineReport 含降级跳过评估，Then 产出 warning 级 finding 且携带原因', () => {
    const report = {
      total: 2,
      passed: 1,
      failed: 0,
      errors: 0,
      skipped: 1,
      ok: true,
      degraded: 1,
      evaluations: [
        {
          rule: { id: 'inspect.scan.typescript.type-error-check', name: '类型检查' },
          status: 'skipped',
          degraded: true,
          message: 'tsc 不可用',
          durationMs: 0,
          targetEngine: 'inspect',
          timestamp: new Date(),
        },
        {
          rule: { id: 'inspect.scan.quality.loc', name: '行数' },
          status: 'passed',
          durationMs: 1,
          targetEngine: 'inspect',
          timestamp: new Date(),
        },
      ],
      durationMs: 5,
      timestamp: new Date(),
    };
    const findings = buildFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].ruleId).toBe('inspect.scan.typescript.type-error-check');
    expect(findings[0].message).toContain('tsc 不可用');
    expect(findings[0].message).toContain('未检测');
  });

  it('Given RuleEngineReport 仅含预期裁剪跳过（out-of-scope），Then 不产出 finding', () => {
    const report = {
      total: 1,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 1,
      ok: true,
      evaluations: [
        {
          rule: { id: 'inspect.scan.python.lint', name: 'Python Lint' },
          status: 'skipped',
          durationMs: 0,
          targetEngine: 'inspect',
          timestamp: new Date(),
        },
      ],
      durationMs: 1,
      timestamp: new Date(),
    };
    expect(buildFindings(report)).toHaveLength(0);
  });

  it('Given InspectionReport 含降级跳过的 adapterResult，Then 产出 warning 级 finding', () => {
    const report = {
      projectId: 'p',
      timestamp: new Date(),
      scanType: 'full',
      duration: 1,
      score: { overall: 100, grade: 'A' },
      issues: [],
      summary: { total: 0, error: 0, warning: 0, info: 0 },
      adapterResults: [
        {
          adapterId: 'inspect.scan.architecture.circular-dependency',
          adapterName: '循环依赖检测',
          duration: 0,
          issueCount: 0,
          passed: false,
          degraded: true,
          status: 'skipped',
          skipReason: 'degraded',
          skipDetail: 'dependency-cruiser 不可用',
          issues: [],
        },
      ],
      recommendations: [],
    };
    const findings = buildFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].message).toContain('dependency-cruiser 不可用');
  });

  it('Given 降级 finding，When 渲染 SARIF，Then results 非空且每条带 locations', () => {
    const sarif = JSON.parse(
      toSarif([
        {
          ruleId: 'inspect.scan.typescript.type-error-check',
          severity: 'warning',
          message: '检查被降级跳过（未检测 ≠ 通过）: 类型检查 — tsc 不可用',
          source: 'inspect',
        },
      ]),
    );
    expect(sarif.runs[0].results).toHaveLength(1);
    expect(sarif.runs[0].results[0].locations).toBeDefined();
  });
});

// 基线豁免可见性：豁免项已从 issues 移除，若不在机器输出里标注，
// CI/审计方无法区分"工具没报出来"与"报出来了但被豁免"，也无法复核豁免理由。
describe('buildFindings — 基线豁免可见性', () => {
  const waivedIssue = {
    ruleId: 'security.scan.semgrep.path-traversal',
    severity: 'warning' as const,
    message: '路径遍历风险',
    file: 'packages/cli/src/index.ts',
    line: 43,
    column: 0,
    category: 'security',
    source: 'inspect',
  };

  const reportWith = (entry: Record<string, unknown>) => ({
    projectId: 'p',
    timestamp: new Date(),
    scanType: 'full',
    duration: 1,
    score: { overall: 100, grade: 'A' },
    issues: [],
    summary: { total: 0, error: 0, warning: 0, info: 0 },
    adapterResults: [],
    recommendations: [],
    suppressedCount: 1,
    suppressedIssues: [{ issue: waivedIssue, entry }],
  });

  it('Given 含豁免明细的报告，Then 产出带 external 豁免标注的 finding', () => {
    const findings = buildFindings(
      reportWith({
        ruleId: waivedIssue.ruleId,
        file: waivedIssue.file,
        line: 43,
        column: 0,
        reason: '污点为已执行脚本自身路径，非外部输入',
        owner: 'security',
        expiresAt: '2027-01-01T00:00:00.000Z',
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].suppression?.kind).toBe('external');
    expect(findings[0].suppression?.justification).toContain('污点为已执行脚本自身路径');
    expect(findings[0].suppression?.justification).toContain('security');
    expect(findings[0].suppression?.justification).toContain('2027-01-01');
  });

  it('豁免理由缺失时 justification 必须显式标注未记录，不得静默省略', () => {
    const findings = buildFindings(
      reportWith({ ruleId: waivedIssue.ruleId, file: waivedIssue.file, line: 43, column: 0 }),
    );
    expect(findings[0].suppression?.justification).toContain('未记录豁免理由');
  });

  it('When 渲染 SARIF，Then 豁免项带原生 suppressions 且 status=accepted', () => {
    const sarif = JSON.parse(
      toSarif([
        {
          ruleId: waivedIssue.ruleId,
          severity: 'warning',
          message: waivedIssue.message,
          file: waivedIssue.file,
          line: 43,
          source: 'inspect',
          suppression: { kind: 'external', justification: '基线豁免：已知误报' },
        },
      ]),
    );
    const [result] = sarif.runs[0].results;
    expect(result.suppressions).toHaveLength(1);
    expect(result.suppressions[0].kind).toBe('external');
    expect(result.suppressions[0].status).toBe('accepted');
    expect(result.suppressions[0].justification).toBe('基线豁免：已知误报');
  });

  it('未豁免的 finding 不应带 suppressions 字段', () => {
    const sarif = JSON.parse(
      toSarif([{ ruleId: 'r', severity: 'error', message: 'm', source: 'inspect' }]),
    );
    expect(sarif.runs[0].results[0].suppressions).toBeUndefined();
  });
});
