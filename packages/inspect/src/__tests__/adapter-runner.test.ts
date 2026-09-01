import { describe, it, expect } from 'vitest';
import { AdapterRunner } from '../adapter-runner';
import type { InspectAdapter, Issue } from '../types';

function makeAdapter(
  id: string,
  name: string,
  issues: Issue[] = [],
  shouldThrow = false,
): InspectAdapter {
  return {
    id,
    name,
    run: shouldThrow
      ? () => {
          throw new Error(`${id} failed`);
        }
      : async () => issues,
  };
}

describe('AdapterRunner', () => {
  it('should register and run a single adapter', async () => {
    const runner = new AdapterRunner();
    const adapter = makeAdapter('eslint', 'ESLint', [
      {
        id: '1',
        ruleId: 'no-var',
        severity: 'error',
        category: 'quality',
        message: 'Use let',
        file: 'a.ts',
        autoFixable: true,
        source: 'eslint',
        fingerprint: 'f1',
      },
    ]);
    runner.register(adapter);

    const results = await runner.runAll({ projectId: 'test' });
    expect(results).toHaveLength(1);
    expect(results[0].adapterId).toBe('eslint');
    expect(results[0].passed).toBe(false);
    expect(results[0].issueCount).toBe(1);
    expect(results[0].issues[0].message).toBe('Use let');
  });

  it('should return passed when adapter has no errors', async () => {
    const runner = new AdapterRunner();
    runner.register(
      makeAdapter('gitleaks', 'Gitleaks', [
        {
          id: '1',
          ruleId: 'R1',
          severity: 'info',
          category: 'security',
          message: 'Info',
          file: 'x.ts',
          autoFixable: false,
          source: 'gitleaks',
          fingerprint: 'f2',
        },
      ]),
    );

    const results = await runner.runAll({});
    expect(results[0].passed).toBe(true);
  });

  it('should handle adapter throwing an error', async () => {
    const runner = new AdapterRunner();
    runner.register(makeAdapter('broken', 'Broken', [], true));

    const results = await runner.runAll({});
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].issues[0].severity).toBe('error');
    expect(results[0].issues[0].message).toContain('broken failed');
  });

  it('should run multiple adapters independently', async () => {
    const runner = new AdapterRunner();
    runner.register(makeAdapter('a', 'AdapterA', []));
    runner.register(
      makeAdapter('b', 'AdapterB', [
        {
          id: '2',
          ruleId: 'R2',
          severity: 'warning',
          category: 'quality',
          message: 'Warn',
          file: 'b.ts',
          autoFixable: false,
          source: 'b',
          fingerprint: 'f3',
        },
      ]),
    );
    runner.register(makeAdapter('c', 'AdapterC', [], true));

    const results = await runner.runAll({});
    expect(results).toHaveLength(3);
    const byId = Object.fromEntries(results.map((r) => [r.adapterId, r]));
    expect(byId['a'].passed).toBe(true);
    expect(byId['a'].issueCount).toBe(0);
    expect(byId['b'].passed).toBe(true);
    expect(byId['b'].issueCount).toBe(1);
    expect(byId['c'].passed).toBe(false);
    expect(byId['c'].issues[0].severity).toBe('error');
  });

  it('should return empty array when no adapters registered', async () => {
    const runner = new AdapterRunner();
    const results = await runner.runAll({});
    expect(results).toEqual([]);
  });

  it('should record duration for each adapter', async () => {
    const runner = new AdapterRunner();
    runner.register(makeAdapter('fast', 'Fast', []));

    const results = await runner.runAll({});
    expect(results[0].duration).toBeGreaterThanOrEqual(0);
  });

  it('should time out a hanging adapter and produce an ADAPTER-ERROR result', async () => {
    const runner = new AdapterRunner(50);
    const hanging: InspectAdapter = {
      id: 'hang',
      name: 'Hang',
      run: () => new Promise<Issue[]>(() => {}),
    };
    runner.register(hanging);

    const results = await runner.runAll({});
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].issues[0].ruleId).toBe('ADAPTER-ERROR');
    expect(results[0].issues[0].message).toContain('硬上限');
  }, 5000);
});
