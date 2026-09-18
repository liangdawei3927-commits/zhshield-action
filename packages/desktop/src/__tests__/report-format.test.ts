import { describe, expect, it } from 'vitest';
import {
  toHealthScoreData,
  toInspectionReportData,
  toSecurityScanReportData,
} from '../../electron/ipc/report-format';

describe('toSecurityScanReportData 映射', () => {
  const report = {
    projectId: 'test',
    timestamp: new Date('2026-08-06T08:00:00.000Z'),
    vulnerabilities: [
      {
        id: 'vuln-1',
        cveId: 'CVE-2026-0001',
        severity: 'high',
        title: 'Test vulnerability',
        description: 'desc',
        package: 'lodash',
        currentVersion: '4.17.20',
        vulnerableRange: '<4.17.21',
        fixedVersion: '4.17.21',
        dependencyPath: ['lodash'],
        isDirectDependency: true,
        cvssScore: 8.1,
        recommendation: 'upgrade',
        autoFixable: true,
      },
    ],
    garbage: [
      { id: 'g-1', type: 'unused-file', path: 'src/old.ts', size: 2048, reason: '未被引用' },
    ],
    malware: [
      {
        id: 'm-1',
        type: 'reverse-shell',
        severity: 'critical',
        title: 'Reverse shell detected',
        description: '检测到反弹Shell特征',
        file: 'src/evil.ts',
        line: 12,
        pattern: 'net.connect',
        evidence: 'const s = net.connect(...)',
      },
    ],
    securityScore: 42,
    summary: {
      vulnTotal: 1,
      vulnCritical: 0,
      vulnHigh: 1,
      vulnMedium: 0,
      vulnLow: 0,
      malwareTotal: 1,
    },
  };

  it('maps vulnerabilities to findings', () => {
    const data = toSecurityScanReportData(report as never);
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]).toMatchObject({
      id: 'vuln-1',
      title: 'Test vulnerability',
      severity: 'high',
      file: 'lodash',
      recommendation: 'upgrade',
    });
  });

  it('maps malware items (previously dropped)', () => {
    const data = toSecurityScanReportData(report as never);
    expect(data.malware).toHaveLength(1);
    expect(data.malware[0]).toMatchObject({
      id: 'm-1',
      type: 'reverse-shell',
      severity: 'critical',
      file: 'src/evil.ts',
      line: 12,
      pattern: 'net.connect',
    });
  });

  it('安全报告不再携带垃圾清单（T5 各司其职：垃圾归垃圾清理域）', () => {
    const data = toSecurityScanReportData(report as never) as Record<string, unknown>;
    // 即使上游 SecurityScanReport 仍带 garbage 字段，安全页也不得再透出
    expect('garbage' in data).toBe(false);
    const summary = data.summary as Record<string, unknown>;
    expect('garbageTotal' in summary).toBe(false);
    expect('garbageSize' in summary).toBe(false);
  });

  it('keeps securityScore and summary totals', () => {
    const data = toSecurityScanReportData(report as never);
    expect(data.securityScore).toBe(42);
    expect(data.summary).toMatchObject({
      total: 1,
      critical: 0,
      high: 1,
      malwareTotal: 1,
    });
  });
});

describe('toInspectionReportData 覆盖率缺口显式上报', () => {
  const baseReport = {
    projectId: 'proj-1',
    timestamp: new Date('2026-08-06T08:00:00.000Z'),
    scanType: 'full',
    duration: 500,
    score: { overall: 100, grade: 'A' },
    summary: { total: 1, error: 0, warning: 1, info: 0 },
    issues: [
      {
        id: 'issue-1',
        ruleId: 'no-var',
        severity: 'warning',
        category: 'quality',
        message: 'Use let/const',
        file: 'src/app.ts',
        line: 10,
        column: 5,
        autoFixable: true,
        source: 'eslint',
        fingerprint: 'no-var:src/app.ts:10',
      },
    ],
    adapterResults: [
      {
        adapterId: 'semgrep',
        adapterName: 'Semgrep',
        duration: 0,
        issueCount: 0,
        passed: true,
        degraded: true,
        status: 'unavailable',
        issues: [],
      },
      {
        adapterId: 'eslint',
        adapterName: 'ESLint',
        duration: 300,
        issueCount: 1,
        passed: true,
        status: 'passed',
        issues: [],
      },
    ],
    recommendations: [],
  };

  it('maps skipped/unavailable adapterResults to attention checks (previously dropped)', () => {
    const data = toInspectionReportData(baseReport as never);
    const attentionChecks = data.checks.filter((c) => c.status === 'attention');
    expect(attentionChecks).toHaveLength(1);
    expect(attentionChecks[0]).toMatchObject({
      id: 'adapter:semgrep',
      name: 'Semgrep',
      detail: expect.stringContaining('未检测'),
      source: 'semgrep',
    });
  });

  it('keeps pass adapterResults out of attention checks', () => {
    const data = toInspectionReportData(baseReport as never);
    expect(data.checks.filter((c) => c.name === 'ESLint' && c.status === 'attention')).toHaveLength(
      0,
    );
  });

  // P1（复查5）：status==='error' 且 0 issue 的适配器此前在桌面端完全隐身，
  // 用户看到"巡检完成"却不知道有工具跑挂了 → 必须落成 fail 检查项并带真实原因。
  it('maps errored adapters with no issues to fail checks carrying the real reason', () => {
    const withErrors = {
      ...baseReport,
      adapterResults: [
        {
          adapterId: 'dep-cruiser',
          adapterName: 'Dependency Cruiser',
          duration: 3174,
          issueCount: 0,
          passed: false,
          status: 'error',
          errorDetail: 'dep-cruiser 未扫描到任何模块（modules=0）',
          issues: [],
        },
      ],
    };
    const data = toInspectionReportData(withErrors as never);
    const failed = data.checks.filter((c) => c.status === 'fail');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      id: 'adapter-error:dep-cruiser',
      name: 'Dependency Cruiser',
      source: 'dep-cruiser',
    });
    expect(failed[0].detail).toContain('dep-cruiser 未扫描到任何模块');
    // 失败计数必须纳入，否则"0 失败"与页面上的红色项互相打脸
    expect(data.summary.failures).toBe(baseReport.summary.error + 1);
  });

  it('does not add a fail check when the errored adapter did produce issues', () => {
    const withIssues = {
      ...baseReport,
      adapterResults: [
        {
          adapterId: 'eslint',
          adapterName: 'ESLint',
          duration: 100,
          issueCount: 1,
          passed: false,
          status: 'error',
          errorDetail: '部分文件解析失败',
          issues: [{ id: 'e-1' }],
        },
      ],
    };
    const data = toInspectionReportData(withIssues as never);
    expect(data.checks.filter((c) => String(c.id).startsWith('adapter-error:'))).toHaveLength(0);
    expect(data.summary.failures).toBe(baseReport.summary.error);
  });

  it('does not duplicate adapter attention when adapter has issues', () => {
    const withIssues = {
      ...baseReport,
      adapterResults: [
        {
          adapterId: 'gitleaks',
          adapterName: 'Gitleaks',
          duration: 100,
          issueCount: 2,
          passed: false,
          status: 'available',
          issues: [{ id: 'g-1' }, { id: 'g-2' }],
        },
      ],
    };
    const data = toInspectionReportData(withIssues as never);
    expect(data.checks.filter((c) => c.status === 'attention')).toHaveLength(0);
  });
});

describe('toHealthScoreData 归一化', () => {
  const score = {
    projectId: 'proj-1',
    timestamp: new Date('2026-08-06T08:00:00.000Z'),
    overall: 83.5,
    grade: 'B',
    trend: 'improving',
    dimensions: [
      { name: 'security', weight: 0.3, score: 90, issues: 0 },
      { name: 'testing', weight: 0.2, score: 70, issues: 3 },
    ],
  };

  it('maps overall to score and grade to summary', () => {
    const data = toHealthScoreData(score as never);
    expect(data.score).toBe(83.5);
    expect(data.summary).toBe('B');
    expect(data.timestamp).toBe('2026-08-06T08:00:00.000Z');
    expect(data.dimensions).toHaveLength(2);
    expect(data.dimensions[0].name).toBe('security');
    expect(data.dimensions[0].score).toBe(90);
  });

  it('has no overall/trend keys leaking to renderer', () => {
    const data = toHealthScoreData(score as never) as Record<string, unknown>;
    expect('overall' in data).toBe(false);
    expect('trend' in data).toBe(false);
  });
});
