import { describe, it, expect } from 'vitest';
import { SecurityEngine } from '../engine';

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
