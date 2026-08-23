import { describe, it, expect } from 'vitest';
import type { CheckResult } from '@zh/guard';
import { convertTraditionalGuardResults } from '../../electron/ipc/score-converters';

function guardResult(overrides: Partial<CheckResult>): CheckResult {
  return {
    checkId: 'c1',
    adapter: 'eslint-check',
    status: 'failed',
    severity: 'error',
    blocking: true,
    message: 'x',
    ...overrides,
  } as CheckResult;
}

describe('convertTraditionalGuardResults', () => {
  it('explodes ESLint aggregated errors into per-file results', () => {
    const r = guardResult({
      adapter: 'eslint-check',
      status: 'failed',
      severity: 'error',
      details: {
        errors: [
          '[no-unused] unused (packages/foo/src/a.ts:1:2)',
          '[no-unused] unused (packages/bar/src/b.ts:3:4)',
        ],
        warnings: [],
        totalErrors: 2,
        totalWarnings: 0,
      },
    });
    const out = convertTraditionalGuardResults([r]);
    expect(out).toHaveLength(2);
    expect(out.every((x) => x.file !== undefined)).toBe(true);
    expect(out.map((x) => x.file)).toEqual(['packages/foo/src/a.ts', 'packages/bar/src/b.ts']);
    expect(out.every((x) => x.severity === 'error' && x.status === 'failed' && x.blocking === true)).toBe(true);
  });

  it('maps ESLint warnings to warning-level per-file results', () => {
    const r = guardResult({
      adapter: 'eslint-check',
      status: 'warning',
      severity: 'warning',
      details: { errors: [], warnings: ['(packages/foo/src/a.ts:1:2)'], totalErrors: 0, totalWarnings: 1 },
    });
    const out = convertTraditionalGuardResults([r]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'warning', status: 'warning', blocking: false, file: 'packages/foo/src/a.ts' });
  });

  it('explodes sensitive-info findings into per-file results', () => {
    const r = guardResult({
      adapter: 'sensitive-info',
      status: 'failed',
      severity: 'error',
      details: {
        findings: [
          { file: 'packages/foo/src/config.ts', line: 5, pattern: 'API Key', match: 'api_key="x"' },
          { file: 'packages/bar/src/secret.ts', line: 9, pattern: 'JWT', match: 'eyJ...' },
        ],
        count: 2,
      },
    });
    const out = convertTraditionalGuardResults([r]);
    expect(out.map((x) => x.file)).toEqual(['packages/foo/src/config.ts', 'packages/bar/src/secret.ts']);
  });

  it('keeps a passed check as a single root-level result (no file)', () => {
    const r = guardResult({ status: 'passed', severity: 'info', blocking: false });
    const out = convertTraditionalGuardResults([r]);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBeUndefined();
    expect(out[0].status).toBe('passed');
  });

  it('falls back to a single root-level result when no file is locatable', () => {
    const r = guardResult({ adapter: 'license-check', status: 'failed', severity: 'error', details: { summary: 'bad license' } });
    const out = convertTraditionalGuardResults([r]);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBeUndefined();
    expect(out[0].status).toBe('failed');
  });

  it('attribution enables module-level bucketing (vs root) for traditional findings', () => {
    const r = guardResult({
      adapter: 'eslint-check',
      status: 'failed',
      severity: 'error',
      details: { errors: ['(packages/foo/src/a.ts:1:2)'], warnings: [], totalErrors: 1, totalWarnings: 0 },
    });
    const out = convertTraditionalGuardResults([r]);
    const fooFile = out.find((x) => x.file?.startsWith('packages/foo/'));
    expect(fooFile).toBeDefined();
    expect(fooFile?.file).toBe('packages/foo/src/a.ts');
  });
});
