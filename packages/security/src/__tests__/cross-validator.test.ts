import { describe, it, expect } from 'vitest';
import { GrypeCrossValidator } from '../cross-validator';
import type { Issue } from '@zh/shared';

function makeIssue(overrides: Partial<Issue> & { ruleId: string; message: string }): Issue {
  return {
    id: overrides.ruleId,
    category: 'security',
    severity: 'error',
    message: overrides.message || '',
    file: overrides.file || '',
    source: 'tool',
    autoFixable: false,
    fingerprint: overrides.fingerprint || '',
    ...overrides,
  };
}

describe('GrypeCrossValidator', () => {
  const validator = new GrypeCrossValidator();

  it('should detect high-confidence matches (A intersect B)', () => {
    const trivy = [
      makeIssue({
        ruleId: 'CVE-2024-1234',
        message: 'lodash@4.17.20: ReDoS',
        fingerprint: 'trivy:CVE-2024-1234:lodash',
      }),
    ];
    const grype = [
      makeIssue({
        ruleId: 'CVE-2024-1234',
        message: 'lodash@4.17.20: ReDoS',
        fingerprint: 'grype:CVE-2024-1234:lodash',
      }),
    ];

    const report = validator.validate(trivy, grype);

    expect(report.highConfidence).toHaveLength(1);
    expect(report.highConfidence[0].confidence).toBe('high_confidence');
    expect(report.highConfidence[0].sources).toContain('trivy');
    expect(report.highConfidence[0].sources).toContain('grype');
    expect(report.trivyOnly).toHaveLength(0);
    expect(report.grypeOnly).toHaveLength(0);
    expect(report.summary.highConfidence).toBe(1);
    expect(report.summary.pendingConfirmation).toBe(0);
  });

  it('should detect trivy-only findings', () => {
    const trivy = [
      makeIssue({
        ruleId: 'CVE-2024-5678',
        message: 'express@4.18.0: XSS',
        fingerprint: 'trivy:CVE-2024-5678:express',
      }),
    ];
    const grype: Issue[] = [];

    const report = validator.validate(trivy, grype);

    expect(report.trivyOnly).toHaveLength(1);
    expect(report.trivyOnly[0].confidence).toBe('pending_confirmation');
    expect(report.trivyOnly[0].sources).toEqual(['trivy']);
    expect(report.highConfidence).toHaveLength(0);
    expect(report.grypeOnly).toHaveLength(0);
  });

  it('should detect grype-only findings', () => {
    const trivy: Issue[] = [];
    const grype = [
      makeIssue({
        ruleId: 'CVE-2024-9999',
        message: 'axios@1.6.0: SSRF',
        fingerprint: 'grype:CVE-2024-9999:axios',
      }),
    ];

    const report = validator.validate(trivy, grype);

    expect(report.grypeOnly).toHaveLength(1);
    expect(report.grypeOnly[0].confidence).toBe('pending_confirmation');
    expect(report.grypeOnly[0].sources).toEqual(['grype']);
    expect(report.highConfidence).toHaveLength(0);
    expect(report.trivyOnly).toHaveLength(0);
  });

  it('should handle mixed results', () => {
    const trivy = [
      makeIssue({
        ruleId: 'CVE-2024-1111',
        message: 'pkg-a@1.0: vuln',
        fingerprint: 'trivy:CVE-2024-1111:pkg-a',
      }),
      makeIssue({
        ruleId: 'CVE-2024-2222',
        message: 'pkg-b@2.0: vuln',
        fingerprint: 'trivy:CVE-2024-2222:pkg-b',
      }),
    ];
    const grype = [
      makeIssue({
        ruleId: 'CVE-2024-1111',
        message: 'pkg-a@1.0: vuln',
        fingerprint: 'grype:CVE-2024-1111:pkg-a',
      }),
      makeIssue({
        ruleId: 'CVE-2024-3333',
        message: 'pkg-c@3.0: vuln',
        fingerprint: 'grype:CVE-2024-3333:pkg-c',
      }),
    ];

    const report = validator.validate(trivy, grype);

    expect(report.highConfidence).toHaveLength(1);
    expect(report.highConfidence[0].cveId).toBe('CVE-2024-1111');
    expect(report.trivyOnly).toHaveLength(1);
    expect(report.trivyOnly[0].cveId).toBe('CVE-2024-2222');
    expect(report.grypeOnly).toHaveLength(1);
    expect(report.grypeOnly[0].cveId).toBe('CVE-2024-3333');
    expect(report.summary.total).toBe(3);
  });

  it('should handle empty inputs', () => {
    const report = validator.validate([], []);
    expect(report.highConfidence).toHaveLength(0);
    expect(report.trivyOnly).toHaveLength(0);
    expect(report.grypeOnly).toHaveLength(0);
    expect(report.summary.total).toBe(0);
  });

  it('should skip non-security issues', () => {
    const trivy = [
      makeIssue({
        ruleId: 'CVE-2024-1234',
        message: 'vuln',
        category: 'dependency',
        fingerprint: 'trivy:CVE-2024-1234:pkg',
      }),
    ];
    const grype = [
      makeIssue({
        ruleId: 'CVE-2024-1234',
        message: 'vuln',
        category: 'security',
        fingerprint: 'grype:CVE-2024-1234:pkg',
      }),
    ];

    const report = validator.validate(trivy, grype);
    expect(report.highConfidence).toHaveLength(0);
    expect(report.grypeOnly).toHaveLength(1);
  });

  it('should degrade severity for pending_confirmation findings', () => {
    const trivy = [
      makeIssue({
        ruleId: 'CVE-2024-5555',
        severity: 'error',
        message: 'pkg@1.0: critical vuln',
        fingerprint: 'trivy:CVE-2024-5555:pkg',
      }),
    ];
    const grype: Issue[] = [];

    const report = validator.validate(trivy, grype);
    expect(report.trivyOnly[0].suggestedSeverity).toBe('warning');
  });

  it('should use max severity for high-confidence findings', () => {
    const trivy = [
      makeIssue({
        ruleId: 'CVE-2024-7777',
        severity: 'error',
        message: 'pkg@1.0: vuln',
        fingerprint: 'trivy:CVE-2024-7777:pkg',
      }),
    ];
    const grype = [
      makeIssue({
        ruleId: 'CVE-2024-7777',
        severity: 'warning',
        message: 'pkg@1.0: vuln',
        fingerprint: 'grype:CVE-2024-7777:pkg',
      }),
    ];

    const report = validator.validate(trivy, grype);
    expect(report.highConfidence[0].suggestedSeverity).toBe('error');
  });
});
