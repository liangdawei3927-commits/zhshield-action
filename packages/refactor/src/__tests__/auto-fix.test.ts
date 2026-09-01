import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { generateFix, generateFixes, applyFixes, isFixable } from '../auto-fix';
import { RefactorEngine } from '../engine';
import { DEFAULT_CONFIG } from '../types';
import type { CodeSmell } from '../types';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

const PRIVATE_PREFIX = /^\s*private\s/;
const ASYNC_FUNC = /async\s+\w+/;

describe('isFixable', () => {
  it('returns true for inappropriate-intimacy', () => {
    expect(isFixable('inappropriate-intimacy')).toBe(true);
  });

  it('returns true for callback-hell', () => {
    expect(isFixable('callback-hell')).toBe(true);
  });

  it('returns true for shotgun-surgery', () => {
    expect(isFixable('shotgun-surgery')).toBe(true);
  });

  it('returns false for unknown rules', () => {
    expect(isFixable('long-method')).toBe(false);
    expect(isFixable('deep-nesting')).toBe(false);
    expect(isFixable('feature-envy')).toBe(false);
  });
});

describe('generateFix - inappropriate-intimacy', () => {
  it('generates private modifier edits for public fields', () => {
    const smell: CodeSmell = {
      id: 'test-1',
      ruleId: 'inappropriate-intimacy',
      category: 'coupling',
      severity: 'error',
      message: 'PublicFields exposes 5 public fields',
      location: {
        filePath: path.join(FIXTURES_DIR, 'intimacy.fixture.ts'),
        line: 1,
        column: 1,
        endLine: 7,
        endColumn: 1,
      },
      context: {
        className: 'PublicFields',
        metric: 'publicFieldCount',
        value: 5,
        threshold: 3,
      },
      suggestion: {
        type: 'Encapsulate Field',
        description: 'Convert public fields to private',
        priority: 'high',
        effort: 'small',
        autoFixable: true,
      },
    };

    const fix = generateFix(smell, FIXTURES_DIR);
    expect(fix).not.toBeNull();
    expect(fix!.ruleId).toBe('inappropriate-intimacy');
    expect(fix!.edits.length).toBe(5);
    expect(fix!.edits[0].replacement).toContain('private ');

    for (const edit of fix!.edits) {
      expect(edit.filePath).toBe(smell.location.filePath);
      expect(edit.startLine).toBeGreaterThanOrEqual(1);
      expect(edit.replacement).toMatch(PRIVATE_PREFIX);
    }
  });

  it('returns null for a class with no public fields (no smell)', () => {
    const smell: CodeSmell = {
      id: 'test-2',
      ruleId: 'inappropriate-intimacy',
      category: 'coupling',
      severity: 'error',
      message: '',
      location: {
        filePath: path.join(FIXTURES_DIR, 'long-method.fixture.ts'),
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 1,
      },
      context: { className: 'OrderService', metric: 'publicFieldCount', value: 0, threshold: 3 },
      suggestion: {
        type: '',
        description: '',
        priority: 'high',
        effort: 'small',
        autoFixable: true,
      },
    };

    // OrderService has no public fields, so no edits
    const fix = generateFix(smell, FIXTURES_DIR);
    expect(fix).toBeNull();
  });
});

describe('generateFix - callback-hell', () => {
  it('generates async keyword insertion for .then() chains', () => {
    const smell: CodeSmell = {
      id: 'test-3',
      ruleId: 'callback-hell',
      category: 'structural',
      severity: 'warning',
      message: 'DataService.fetchData() has 4 .then() chains',
      location: {
        filePath: path.join(FIXTURES_DIR, 'callback.fixture.ts'),
        line: 3,
        column: 1,
        endLine: 8,
        endColumn: 1,
      },
      context: {
        className: 'DataService',
        methodName: 'fetchData',
        metric: 'thenChainCount',
        value: 4,
        threshold: 3,
      },
      suggestion: {
        type: 'Convert to Async/Await',
        description: 'Convert .then() chains to async/await',
        priority: 'medium',
        effort: 'small',
        autoFixable: true,
      },
    };

    const fix = generateFix(smell, FIXTURES_DIR);
    expect(fix).not.toBeNull();
    expect(fix!.ruleId).toBe('callback-hell');
    expect(fix!.edits.length).toBeGreaterThanOrEqual(1);

    const asyncEdit = fix!.edits.find((e) => e.replacement.includes('async '));
    expect(asyncEdit).toBeDefined();
    expect(asyncEdit!.replacement).toMatch(ASYNC_FUNC);
  });
});

describe('generateFixes', () => {
  it('filters only autoFixable smells and generates fixes', () => {
    const autoFixable: CodeSmell = {
      id: 'test-a',
      ruleId: 'inappropriate-intimacy',
      category: 'coupling',
      severity: 'error',
      message: '',
      location: {
        filePath: path.join(FIXTURES_DIR, 'intimacy.fixture.ts'),
        line: 1,
        column: 1,
        endLine: 7,
        endColumn: 1,
      },
      context: { className: 'PublicFields', metric: 'publicFieldCount', value: 5, threshold: 3 },
      suggestion: {
        type: '',
        description: '',
        priority: 'high',
        effort: 'small',
        autoFixable: true,
      },
    };
    const nonAutoFixable: CodeSmell = {
      id: 'test-b',
      ruleId: 'long-method',
      category: 'structural',
      severity: 'warning',
      message: '',
      location: {
        filePath: path.join(FIXTURES_DIR, 'long-method.fixture.ts'),
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 1,
      },
      context: {
        className: 'OrderService',
        methodName: 'processOrder',
        metric: 'lineCount',
        value: 100,
        threshold: 80,
      },
      suggestion: {
        type: '',
        description: '',
        priority: 'medium',
        effort: 'medium',
        autoFixable: false,
      },
    };

    const fixes = generateFixes([autoFixable, nonAutoFixable], FIXTURES_DIR);
    expect(fixes.length).toBe(1);
    expect(fixes[0].ruleId).toBe('inappropriate-intimacy');
  });
});

describe('generateFixes via RefactorEngine', () => {
  const tmpFile = path.join('/tmp', 'intimacy-engine-test-target.ts');

  afterAll(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it('generates fixes for an intentional public-field smell', async () => {
    const original =
      'export class PublicFields {\n  public name: string;\n  public age: number;\n  public email: string;\n  public address: string;\n  public phone: string;\n}\n';
    fs.writeFileSync(tmpFile, original, 'utf-8');

    const engine = new RefactorEngine({
      enabledRules: ['inappropriate-intimacy'],
      thresholds: { ...DEFAULT_CONFIG.thresholds, maxClassLines: 500 },
    });
    const report = await engine.analyzeFiles('/tmp', [tmpFile]);
    expect(report.totalSmells).toBeGreaterThanOrEqual(1);

    const allSmells = report.files.flatMap((f) => f.smells);
    const fixes = await engine.generateFixes('/tmp', allSmells);
    expect(fixes.length).toBeGreaterThanOrEqual(1);

    // Verify the fix edits
    const intimacyFix = fixes.find((f) => f.ruleId === 'inappropriate-intimacy');
    expect(intimacyFix).toBeDefined();
    expect(intimacyFix!.edits.length).toBe(5);

    // Restore
    fs.writeFileSync(tmpFile, original, 'utf-8');
  });

  it('does not flag decorator-managed classes (DTO/entity) as inappropriate intimacy', async () => {
    const decoratedFile = path.join('/tmp', 'decorated-dto-test-target.ts');
    const content =
      'export class ListResponseDto {\n  @ApiProperty()\n  declare readonly items: string[];\n\n  @ApiProperty()\n  declare readonly total: number;\n\n  @ApiProperty()\n  declare readonly limit: number;\n\n  @ApiProperty()\n  declare readonly offset: number;\n}\n';
    fs.writeFileSync(decoratedFile, content, 'utf-8');
    try {
      const engine = new RefactorEngine({
        enabledRules: ['inappropriate-intimacy'],
      });
      const report = await engine.analyzeFiles('/tmp', [decoratedFile]);
      const intimacySmells = report.files.flatMap((f) =>
        f.smells.filter((s) => s.ruleId === 'inappropriate-intimacy'),
      );
      expect(intimacySmells.length).toBe(0);
    } finally {
      try {
        fs.unlinkSync(decoratedFile);
      } catch {
        /* ignore */
      }
    }
  });
});

describe('applyFixes', () => {
  const tmpFile = path.join('/tmp', 'auto-fix-test-target.ts');

  afterAll(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it('applies edits to a temp file and restores content', () => {
    const original =
      'export class Test {\n  public x: number;\n  public y: string;\n  public z: boolean;\n}\n';
    fs.writeFileSync(tmpFile, original, 'utf-8');

    const fixes = [
      {
        smellId: 'test',
        ruleId: 'inappropriate-intimacy',
        description: 'Fix public fields',
        edits: [
          {
            filePath: tmpFile,
            startLine: 2,
            startColumn: 1,
            endLine: 2,
            endColumn: 24,
            replacement: '  private x: number;',
          },
          {
            filePath: tmpFile,
            startLine: 3,
            startColumn: 1,
            endLine: 3,
            endColumn: 23,
            replacement: '  private y: string;',
          },
          {
            filePath: tmpFile,
            startLine: 4,
            startColumn: 1,
            endLine: 4,
            endColumn: 24,
            replacement: '  private z: boolean;',
          },
        ],
      },
    ];

    const result = applyFixes(fixes);
    expect(result.fixed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);

    const content = fs.readFileSync(tmpFile, 'utf-8');
    expect(content).not.toContain('public x:');
    expect(content).not.toContain('public y:');
    expect(content).not.toContain('public z:');
    expect(content).toContain('private x:');
    expect(content).toContain('private y:');
    expect(content).toContain('private z:');

    // Restore
    fs.writeFileSync(tmpFile, original, 'utf-8');
  });

  it('reports failure for non-existent file', () => {
    const fixes = [
      {
        smellId: 'test',
        ruleId: 'inappropriate-intimacy',
        description: '',
        edits: [
          {
            filePath: '/tmp/nonexistent-dir-12345/test.ts',
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 1,
            replacement: 'test',
          },
        ],
      },
    ];

    const result = applyFixes(fixes);
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });
});
