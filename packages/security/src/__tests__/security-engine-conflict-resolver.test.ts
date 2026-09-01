import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolAdapter, Issue } from '@zh/shared';
import { SecurityEngine } from '../engine';

const FIXTURE_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

const EVAL_PATTERN_SOURCE = 'eval\\s*\\(\\s*(?:Buffer\\.from|atob)\\s*\\(';

function semgrepAdapter(issue: Issue): ToolAdapter {
  return {
    meta: { id: 'semgrep', name: 'Semgrep', version: '1.0.0', category: 'security' as const },
    isAvailable: async () => true as const,
    scan: async () => ({
      status: 'available' as const,
      issues: [issue],
      metadata: { fileCount: 1 },
    }),
  };
}

describe('SecurityEngine × RuleConflictResolver (F3 integration)', () => {
  it('leaves a clean scan unchanged and reports an empty conflict report', async () => {
    const engine = new SecurityEngine();
    const report = await engine.runSecurityScan(
      'clean-proj',
      path.join(FIXTURE_ROOT, 'injection', 'scripts', 'clean'),
    );

    expect(report.malware).toEqual([]);
    expect(report.summary.malwareTotal).toBe(0);
    expect(report.conflictReport).toBeDefined();
    expect(report.conflictReport?.summary).toEqual({
      total: 0,
      confirmed: 0,
      falsePositives: 0,
      conflicts: 0,
      invalid: 0,
    });
  });

  it('collapses duplicate findings from two producers into one confirmed entry', async () => {
    const evilFile = path.join(FIXTURE_ROOT, 'conflict-resolver', 'evil.ts');
    const engine = new SecurityEngine();
    engine.registerAdapter(
      semgrepAdapter({
        id: 'semgrep-eval-dup',
        ruleId: EVAL_PATTERN_SOURCE,
        severity: 'error',
        category: 'security',
        message: 'Base64/Buffer eval detected',
        file: evilFile,
        line: 1,
        source: 'security',
        autoFixable: false,
        fingerprint: 'semgrep:dup-irrelevant',
      }),
    );

    const report = await engine.runSecurityScan(
      'dup-proj',
      path.join(FIXTURE_ROOT, 'conflict-resolver'),
    );

    const evalFindings = report.malware.filter((m) => m.file === evilFile && m.line === 1);
    expect(evalFindings).toHaveLength(1);
    expect(report.summary.malwareTotal).toBe(report.malware.length);

    const confirmedEval = report.conflictReport?.confirmed.find(
      (c) => c.fingerprint === `${evilFile}:1:${EVAL_PATTERN_SOURCE}`,
    );
    expect(confirmedEval).toBeDefined();
    expect(confirmedEval?.confidence).toBe('corroborated');
    expect(confirmedEval?.sources).toEqual(['malware-heuristic', 'semgrep']);
  });

  it('keeps the no-adapters baseline intact with conflictReport attached', async () => {
    const engine = new SecurityEngine();
    const report = await engine.runSecurityScan('empty-proj', '/tmp/nonexistent-zhshield-f3');

    expect(report.vulnerabilities).toEqual([]);
    expect(report.garbage).toEqual([]);
    expect(report.malware).toEqual([]);
    expect(report.securityScore).toBe(100);
    expect(report.conflictReport?.summary.total).toBe(0);
  });
});
