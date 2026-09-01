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
      garbageTotal: 1,
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

  it('maps garbage items with size (previously dropped)', () => {
    const data = toSecurityScanReportData(report as never);
    expect(data.garbage).toHaveLength(1);
    expect(data.garbage[0]).toMatchObject({
      id: 'g-1',
      type: 'unused-file',
      path: 'src/old.ts',
      size: 2048,
    });
  });

  it('keeps securityScore and summary totals', () => {
    const data = toSecurityScanReportData(report as never);
    expect(data.securityScore).toBe(42);
    expect(data.summary).toMatchObject({
      total: 1,
      critical: 0,
      high: 1,
      malwareTotal: 1,
      garbageTotal: 1,
      garbageSize: 2048,
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
