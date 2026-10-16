import { describe, it, expect } from 'vitest';
import { countSmellsByFileAndRule, diffBaseline } from '../baseline';
import type { CodeSmell, FileSmellReport, RefactorReport } from '../types';

function makeSmell(ruleId: string): CodeSmell {
  return {
    id: `${ruleId}:1`,
    ruleId,
    category: 'test',
    severity: 'warning',
    message: 'm',
    location: { filePath: '', line: 1, column: 1, endLine: 1, endColumn: 1 },
    context: { metric: 'm', value: 1, threshold: 2 },
    suggestion: {
      type: 'manual',
      description: 'd',
      priority: 'low',
      effort: 'small',
      autoFixable: false,
    },
  };
}

function makeReport(files: Array<{ filePath: string; rules: string[] }>): RefactorReport {
  const fileReports: FileSmellReport[] = files.map((f) => ({
    filePath: f.filePath,
    totalSmells: f.rules.length,
    smells: f.rules.map(makeSmell),
    maintainabilityScore: 80,
    refactorPriority: 'low',
  }));
  return {
    timestamp: '2026-10-15T00:00:00.000Z',
    projectRoot: '/proj',
    totalFiles: files.length,
    scannedFiles: files.length,
    totalSmells: files.reduce((s, f) => s + f.rules.length, 0),
    byCategory: {},
    bySeverity: { error: 0, warning: 0, info: 0 },
    files: fileReports,
    summary: { criticalFiles: 0, needsImmediateAction: 0, suggestionsByType: {} },
  };
}

describe('baseline', () => {
  const root = '/proj';

  it('identical → no introduced/resolved', () => {
    const report = makeReport([
      { filePath: '/proj/src/a.ts', rules: ['long-method'] },
    ]);
    const current = countSmellsByFileAndRule(report, root);
    const baseline = countSmellsByFileAndRule(report, root);
    const diff = diffBaseline(current, baseline);
    expect(diff.introduced).toEqual([]);
    expect(diff.resolved).toEqual([]);
  });

  it('added smell → introduced', () => {
    const before = makeReport([{ filePath: '/proj/src/a.ts', rules: [] }]);
    const after = makeReport([{ filePath: '/proj/src/a.ts', rules: ['long-method'] }]);
    const diff = diffBaseline(
      countSmellsByFileAndRule(after, root),
      countSmellsByFileAndRule(before, root),
    );
    expect(diff.introduced).toEqual([
      { file: 'src/a.ts', rule: 'long-method', current: 1, baseline: 0 },
    ]);
    expect(diff.resolved).toEqual([]);
  });

  it('removed smell → resolved', () => {
    const before = makeReport([{ filePath: '/proj/src/a.ts', rules: ['long-method'] }]);
    const after = makeReport([{ filePath: '/proj/src/a.ts', rules: [] }]);
    const diff = diffBaseline(
      countSmellsByFileAndRule(after, root),
      countSmellsByFileAndRule(before, root),
    );
    expect(diff.resolved).toEqual([
      { file: 'src/a.ts', rule: 'long-method', current: 0, baseline: 1 },
    ]);
    expect(diff.introduced).toEqual([]);
  });

  it('brand-new file → introduced', () => {
    const before = makeReport([]);
    const after = makeReport([
      { filePath: '/proj/src/b.ts', rules: ['long-method', 'long-method'] },
    ]);
    const diff = diffBaseline(
      countSmellsByFileAndRule(after, root),
      countSmellsByFileAndRule(before, root),
    );
    expect(diff.introduced).toEqual([
      { file: 'src/b.ts', rule: 'long-method', current: 2, baseline: 0 },
    ]);
  });

  it('new rule on existing file → introduced', () => {
    const before = makeReport([{ filePath: '/proj/src/a.ts', rules: ['long-method'] }]);
    const after = makeReport([
      { filePath: '/proj/src/a.ts', rules: ['long-method', 'duplicated-code'] },
    ]);
    const diff = diffBaseline(
      countSmellsByFileAndRule(after, root),
      countSmellsByFileAndRule(before, root),
    );
    expect(diff.introduced).toEqual([
      { file: 'src/a.ts', rule: 'duplicated-code', current: 1, baseline: 0 },
    ]);
    expect(diff.resolved).toEqual([]);
  });

  it('path relativization is POSIX', () => {
    const report = makeReport([
      { filePath: '/proj/src/sub/c.ts', rules: ['x'] },
      { filePath: '/proj/src/deep\\nested\\d.ts', rules: ['x'] },
    ]);
    const keys = Object.keys(countSmellsByFileAndRule(report, root)).sort();
    expect(keys).toEqual(['src/deep/nested/d.ts', 'src/sub/c.ts']);
    for (const k of keys) expect(k).not.toContain('\\');
  });

  it('deterministic sort by file then rule', () => {
    const report = makeReport([
      { filePath: '/proj/z.ts', rules: ['b-rule', 'a-rule'] },
      { filePath: '/proj/a.ts', rules: ['z-rule', 'a-rule'] },
    ]);
    const baseline: Record<string, Record<string, number>> = {
      'z.ts': { 'a-rule': 9 },
      'a.ts': { 'z-rule': 9 },
    };
    const diff = diffBaseline(countSmellsByFileAndRule(report, root), baseline);
    expect(diff.introduced.map((i) => `${i.file}:${i.rule}`)).toEqual([
      'a.ts:a-rule',
      'z.ts:b-rule',
    ]);
    expect(diff.resolved.map((r) => `${r.file}:${r.rule}`)).toEqual([
      'a.ts:z-rule',
      'z.ts:a-rule',
    ]);
  });
});
