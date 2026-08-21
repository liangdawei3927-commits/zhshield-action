import { describe, it, expect } from 'vitest';
import { SecurityEngine } from '../engine';
import { calculateSecurityScore, type MalwareItem, type Vulnerability } from '../types';

const vuln = (severity: Vulnerability['severity']): Vulnerability => ({
  id: `v-${severity}`,
  severity,
  title: '漏洞',
  description: '',
  package: 'dep',
  currentVersion: '1.0.0',
  vulnerableRange: '<2.0.0',
  dependencyPath: ['dep'],
  isDirectDependency: true,
  recommendation: '升级',
  autoFixable: false,
});

const mal = (severity: MalwareItem['severity']): MalwareItem => ({
  id: `m-${severity}`,
  type: 'backdoor',
  severity,
  title: '后门',
  description: '',
  file: 'src/b.ts',
  line: 2,
  pattern: 'net.connect',
  evidence: 'line 2',
});

describe('calculateSecurityScore', () => {
  it('no issues is 100', () => {
    expect(calculateSecurityScore([], [])).toBe(100);
  });

  it('low/medium vulnerabilities deduct lightly but stay >= 60', () => {
    expect(calculateSecurityScore([vuln('low')], [])).toBe(98);
    expect(calculateSecurityScore([vuln('medium')], [])).toBe(95);
    expect(calculateSecurityScore([vuln('medium'), vuln('medium')], [])).toBe(90);
    expect(calculateSecurityScore(Array.from({ length: 8 }, () => vuln('medium')), [])).toBe(60);
  });

  it('high/critical vulnerabilities drop below 60', () => {
    expect(calculateSecurityScore([vuln('high')], [])).toBe(45);
    expect(calculateSecurityScore([vuln('critical')], [])).toBe(45);
    expect(calculateSecurityScore([vuln('high'), vuln('high')], [])).toBe(30);
  });

  it('12 backdoors score far below 100', () => {
    const backdoors = Array.from({ length: 12 }, () => mal('critical'));
    expect(calculateSecurityScore([], backdoors)).toBeLessThanOrEqual(0);
  });

  it('one backdoor plus no vulns still drops below 60', () => {
    expect(calculateSecurityScore([], [mal('critical')])).toBe(35);
    expect(calculateSecurityScore([], [mal('high')])).toBe(35);
  });

  it('malware with only low/medium severity deducts and lowers floor to 30', () => {
    expect(calculateSecurityScore([], [mal('low')])).toBe(95);
    expect(calculateSecurityScore([], [mal('medium')])).toBe(90);
    expect(calculateSecurityScore([], Array.from({ length: 7 }, () => mal('medium')))).toBe(30);
  });

  it('mixed severe vuln and malware stack penalties', () => {
    expect(calculateSecurityScore([vuln('critical')], [mal('critical')])).toBe(20);
  });
});

describe('SecurityEngine', () => {
  it('should construct without errors', () => {
    const engine = new SecurityEngine();
    expect(engine).toBeDefined();
  });

  it('should return tool manager', () => {
    const engine = new SecurityEngine();
    expect(engine.getToolManager()).toBeDefined();
  });

  it('should return degradation manager', () => {
    const engine = new SecurityEngine();
    expect(engine.getDegradationManager()).toBeDefined();
  });

  it('should run security scan with no adapters', async () => {
    const engine = new SecurityEngine();
    const report = await engine.runSecurityScan('test-proj', '/tmp/nonexistent');

    expect(report).toBeDefined();
    expect(report.projectId).toBe('test-proj');
    expect(report.timestamp).toBeInstanceOf(Date);
    expect(report.vulnerabilities).toEqual([]);
    expect(report.garbage).toEqual([]);
    expect(report.malware).toEqual([]);
    expect(report.summary.vulnTotal).toBe(0);
    expect(report.summary.garbageTotal).toBe(0);
    expect(report.summary.malwareTotal).toBe(0);
  });

  it('should calculate security score with no issues as 100', async () => {
    const engine = new SecurityEngine();
    const report = await engine.runSecurityScan('test-proj', '/tmp/nonexistent');
    expect(report.securityScore).toBe(100);
  });

  it('should register adapter', () => {
    const engine = new SecurityEngine();
    const mockAdapter = {
      meta: { id: 'test-tool', name: 'Test Tool', version: '1.0.0', category: 'security' as const },
      isAvailable: async () => true as const,
      scan: async () => ({ status: 'available' as const, issues: [], metadata: { fileCount: 0 } }),
    };
    engine.registerAdapter(mockAdapter);
    expect(engine.getToolManager()).toBeDefined();
  });
});
