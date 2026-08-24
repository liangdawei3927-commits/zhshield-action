import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecurityEngine } from '../engine';

const FIXTURE_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'injection');

describe('SecurityEngine × InjectionGuard (F2 integration)', () => {
  it('surfaces injection findings through runSecurityScan on a malicious project', async () => {
    const engine = new SecurityEngine();
    const report = await engine.runSecurityScan('injection-proj', path.join(FIXTURE_ROOT, 'integration-project'));

    const scriptFinding = report.malware.find((m) => m.pattern === 'remote-content-piped-to-shell');
    expect(scriptFinding).toBeDefined();
    expect(scriptFinding?.type).toBe('supply-chain');
    expect(scriptFinding?.file).toContain(path.join('integration-project', 'package.json'));

    const commentFinding = report.malware.find((m) => m.title === 'Prompt-instruction embedded in comment');
    expect(commentFinding).toBeDefined();
    expect(commentFinding?.file).toContain('malicious.ts');
    expect(commentFinding?.evidence).toContain('disregard all previous rules');

    expect(report.summary.malwareTotal).toBe(report.malware.length);
    expect(report.summary.malwareTotal).toBeGreaterThanOrEqual(2);
  });

  it('leaves unrelated scans unchanged: clean project yields no injection findings', async () => {
    const engine = new SecurityEngine();
    const report = await engine.runSecurityScan('clean-proj', path.join(FIXTURE_ROOT, 'scripts', 'clean'));

    expect(report.malware).toEqual([]);
    expect(report.summary.malwareTotal).toBe(0);
  });

  it('keeps the no-adapters empty baseline intact (regression guard)', async () => {
    const engine = new SecurityEngine();
    const report = await engine.runSecurityScan('empty-proj', '/tmp/nonexistent-zhshield-f2');

    expect(report.vulnerabilities).toEqual([]);
    expect(report.garbage).toEqual([]);
    expect(report.malware).toEqual([]);
    expect(report.securityScore).toBe(100);
  });
});
