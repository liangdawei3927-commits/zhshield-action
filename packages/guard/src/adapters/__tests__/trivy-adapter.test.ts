import { describe, it, expect, vi } from 'vitest';
import { TrivyAdapter } from '../trivy-adapter';
import { GuardTrivyAdapter } from '../guard-trivy-adapter';
import type { CheckConfig } from '../../types';

// ─── Helper ───────────────────────────────────────────────

function makeCheck(overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    checkId: 'trivy-check',
    adapter: 'trivy',
    enabled: true,
    mode: ['guard'],
    category: 'security',
    severity: 'error',
    blocking: true,
    description: 'Trivy security check',
    ...overrides,
  };
}

// ─── TrivyAdapter ─────────────────────────────────────────

describe('TrivyAdapter', () => {
  it('should instantiate with default trivy path', () => {
    const adapter = new TrivyAdapter();
    expect(adapter).toBeDefined();
  });

  it('should instantiate with custom trivy path', () => {
    const adapter = new TrivyAdapter('/usr/local/bin/trivy');
    expect(adapter).toBeDefined();
  });

  it('should report unavailable when trivy is not installed', async () => {
    const adapter = new TrivyAdapter('nonexistent-trivy-binary');
    const available = await adapter.isAvailable();
    expect(available).toBe(false);
  });

  it('should return empty findings when scan fails', async () => {
    const adapter = new TrivyAdapter('nonexistent-trivy-binary');
    const findings = await adapter.scanVulnerabilities('/tmp/nonexistent');
    expect(findings).toEqual([]);
  });

  it('should return empty misconfigurations when scan fails', async () => {
    const adapter = new TrivyAdapter('nonexistent-trivy-binary');
    const findings = await adapter.scanMisconfigurations('/tmp/nonexistent');
    expect(findings).toEqual([]);
  });

  it('should return empty summary when full scan fails', async () => {
    const adapter = new TrivyAdapter('nonexistent-trivy-binary');
    const result = await adapter.scan('/tmp/nonexistent');
    expect(result.vulnerabilities).toEqual([]);
    expect(result.misconfigurations).toEqual([]);
    expect(result.summary).toEqual({ total: 0, critical: 0, high: 0, medium: 0, low: 0 });
  });
});

// ─── GuardTrivyAdapter ────────────────────────────────────

describe('GuardTrivyAdapter', () => {
  it('should instantiate with default trivy path', () => {
    const adapter = new GuardTrivyAdapter();
    expect(adapter.id).toBe('trivy');
    expect(adapter.name).toBe('Trivy Security Scanner');
  });

  it('should report unavailable when trivy is not installed', async () => {
    const adapter = new GuardTrivyAdapter('nonexistent-trivy-binary');
    const available = await adapter.isAvailable();
    expect(available).toBe(false);
  });

  it('should return error status when trivy is not available', async () => {
    const adapter = new GuardTrivyAdapter('nonexistent-trivy-binary');
    const result = await adapter.check('/tmp/nonexistent');
    expect(result.status).toBe('error');
    expect(result.adapterId).toBe('trivy');
    expect(result.message).toContain('not installed');
    expect(result.findings).toEqual([]);
  });

  it('should return error status when check throws', async () => {
    const adapter = new GuardTrivyAdapter('nonexistent-trivy-binary');
    const result = await adapter.check('/tmp');
    expect(result.status).toBe('error');
    expect(result.adapterId).toBe('trivy');
    expect(result.message).toContain('not installed');
    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({ total: 0, critical: 0, high: 0, medium: 0, low: 0 });
  });
});

// ─── GuardTrivyAdapter normalize ──────────────────────────

describe('GuardTrivyAdapter normalize', () => {
  it('should return passed when no critical or high findings', () => {
    const adapter = new GuardTrivyAdapter();
    const check = makeCheck();
    const rawResult = {
      adapterId: 'trivy',
      status: 'passed' as const,
      severity: 'low' as const,
      message: 'No critical or high severity issues found',
      findings: [],
      summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    };
    const result = adapter.normalize(rawResult, {}, check);
    expect(result.status).toBe('passed');
    expect(result.checkId).toBe('trivy-check');
    expect(result.adapter).toBe('trivy');
  });

  it('should return failed when critical findings exist', () => {
    const adapter = new GuardTrivyAdapter();
    const check = makeCheck();
    const rawResult = {
      adapterId: 'trivy',
      status: 'failed' as const,
      severity: 'critical' as const,
      message: 'Found 1 critical vulnerabilities',
      findings: [
        {
          id: 'CVE-2024-0001',
          target: 'package.json',
          vulnerability: {
            vulnerabilityId: 'CVE-2024-0001',
            severity: 'CRITICAL',
            title: 'Critical vulnerability',
            description: 'A critical vulnerability',
          },
        },
      ],
      summary: { total: 1, critical: 1, high: 0, medium: 0, low: 0 },
    };
    const result = adapter.normalize(rawResult, {}, check);
    expect(result.status).toBe('failed');
    expect(result.severity).toBe('error');
    expect(result.blocking).toBe(true);
  });

  it('should return error status when scan errors', () => {
    const adapter = new GuardTrivyAdapter();
    const check = makeCheck();
    const rawResult = {
      adapterId: 'trivy',
      status: 'error' as const,
      severity: 'low' as const,
      message: 'Trivy is not installed or not in PATH',
      findings: [],
      summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    };
    const result = adapter.normalize(rawResult, {}, check);
    expect(result.status).toBe('error');
    expect(result.blocking).toBe(true);
  });

  it('should return info severity when passed and non-blocking check', () => {
    const adapter = new GuardTrivyAdapter();
    const check = makeCheck({ blocking: false });
    const rawResult = {
      adapterId: 'trivy',
      status: 'passed' as const,
      severity: 'low' as const,
      message: 'No critical or high severity issues found',
      findings: [],
      summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    };
    const result = adapter.normalize(rawResult, {}, check);
    expect(result.status).toBe('passed');
    expect(result.severity).toBe('info');
    expect(result.blocking).toBe(false);
  });
});
