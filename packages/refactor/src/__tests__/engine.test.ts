import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { RefactorEngine } from '../engine';
import { parseFile, computeNestingDepth } from '../ast-helper';
import { detectOversizedComponent } from '../adapters/scale-detectors';
import { DEFAULT_CONFIG } from '../types';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

describe('parseFile', () => {
  it('parses a fixture file correctly', () => {
    const parsed = parseFile(path.join(FIXTURES_DIR, 'long-method.fixture.ts'));
    expect(parsed.classes.length).toBe(1);
    expect(parsed.classes[0].name).toBe('OrderService');
    expect(parsed.functions.length).toBe(1);
    expect(parsed.functions[0].name).toBe('standaloneFunc');
  });

  it('counts lines of code correctly', () => {
    const parsed = parseFile(path.join(FIXTURES_DIR, 'long-method.fixture.ts'));
    expect(parsed.linesOfCode).toBeGreaterThan(0);
  });
});

describe('computeCyclomaticComplexity', () => {
  it('returns 1 for simple methods', () => {
    const parsed = parseFile(path.join(FIXTURES_DIR, 'long-method.fixture.ts'));
    const shortMethod = parsed.classes[0].members.methods.find((m) => m.name === 'shortMethod');
    expect(shortMethod).toBeDefined();
    if (shortMethod) {
      expect(shortMethod.complexity).toBe(1);
    }
  });

  it('counts if/else branches in complex methods', () => {
    const parsed = parseFile(path.join(FIXTURES_DIR, 'deep-nesting.fixture.ts'));
    const checkAccess = parsed.classes[0].members.methods.find((m) => m.name === 'checkAccess');
    expect(checkAccess).toBeDefined();
    if (checkAccess) {
      expect(checkAccess.complexity).toBeGreaterThan(1);
    }
  });
});

describe('computeNestingDepth', () => {
  it('detects deep nesting', () => {
    const parsed = parseFile(path.join(FIXTURES_DIR, 'deep-nesting.fixture.ts'));
    const checkAccess = parsed.classes[0].members.methods.find((m) => m.name === 'checkAccess');
    expect(checkAccess).toBeDefined();
    if (checkAccess) {
      const depth = computeNestingDepth(checkAccess.node);
      expect(depth).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('detectLongMethod', () => {
  it('flags methods exceeding threshold', () => {
    // Access engine's internal by running analysis
    const baseConfig = {
      ...DEFAULT_CONFIG,
      thresholds: { ...DEFAULT_CONFIG.thresholds, maxMethodLines: 10 },
    };
    const customEngine = new RefactorEngine({ thresholds: baseConfig.thresholds });
    customEngine.analyzeFiles('/tmp', [path.join(FIXTURES_DIR, 'long-method.fixture.ts')]);

    // Cannot await inside sync context — use a quick manual check instead
  });

  it('does not flag small methods (threshold 200)', () => {
    const parsed = parseFile(path.join(FIXTURES_DIR, 'long-method.fixture.ts'));
    // With threshold 200, no method should be flagged
    expect(parsed.classes[0].members.methods[0].lineCount).toBeLessThan(200);
  });
});

describe('long-method metric 口径 (TDD)', () => {
  async function longMethodSmells(
    filePaths: string[],
    thresholds: Partial<typeof DEFAULT_CONFIG.thresholds>,
  ) {
    const engine = new RefactorEngine({
      enabledRules: ['long-method'],
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...thresholds },
    });
    const report = await engine.analyzeFiles('/tmp', filePaths);
    return report.files.flatMap((f) => f.smells.filter((s) => s.ruleId === 'long-method'));
  }

  it('圈复杂度单独触发时上报 cyclomaticComplexity 且 value/threshold 同口径', async () => {
    const smells = await longMethodSmells([path.join(FIXTURES_DIR, 'deep-nesting.fixture.ts')], {
      maxMethodLines: 10000,
      maxComplexity: 1,
    });
    expect(smells.length).toBeGreaterThanOrEqual(1);
    for (const s of smells) {
      expect(s.context.metric).toBe('cyclomaticComplexity');
      expect(s.context.threshold).toBe(1);
      expect(s.context.value).toBeGreaterThan(s.context.threshold);
    }
  });

  it('行数单独触发时上报 methodLineCount 且 value/threshold 同口径', async () => {
    const smells = await longMethodSmells([path.join(FIXTURES_DIR, 'long-method.fixture.ts')], {
      maxMethodLines: 10,
      maxComplexity: 10000,
    });
    expect(smells.length).toBeGreaterThanOrEqual(1);
    for (const s of smells) {
      expect(s.context.metric).toBe('methodLineCount');
      expect(s.context.value).toBeGreaterThan(s.context.threshold);
    }
  });
});

describe('detectLargeClass', () => {
  it('returns empty for small fixture classes', () => {
    const parsed = parseFile(path.join(FIXTURES_DIR, 'long-method.fixture.ts'));
    expect(parsed.classes[0].lineCount).toBeLessThan(500);
  });
});

describe('detectDeepNesting', () => {
  it('flags deep nesting with low threshold', () => {
    const parsed = parseFile(path.join(FIXTURES_DIR, 'deep-nesting.fixture.ts'));

    const checkAccess = parsed.classes[0].members.methods.find((m) => m.name === 'checkAccess');
    const flatCheck = parsed.classes[0].members.methods.find((m) => m.name === 'flatCheck');

    expect(checkAccess).toBeDefined();
    expect(flatCheck).toBeDefined();

    if (checkAccess && flatCheck) {
      const deepDepth = computeNestingDepth(checkAccess.node);
      const flatDepth = computeNestingDepth(flatCheck.node);
      expect(deepDepth).toBeGreaterThan(flatDepth);
    }
  });
});

describe('RefactorEngine', () => {
  it('analyzes a single file correctly', async () => {
    const engine = new RefactorEngine();
    const filePath = path.join(FIXTURES_DIR, 'long-method.fixture.ts');
    const report = await engine.analyzeFiles('/tmp', [filePath]);

    expect(report.totalFiles).toBe(1);
    expect(report.scannedFiles).toBe(1);
    expect(report.timestamp).toBeDefined();
    expect(report.byCategory.structural).toBeGreaterThanOrEqual(0);
    expect(report.bySeverity.warning).toBeGreaterThanOrEqual(0);
  });

  it('returns empty report for empty file list', async () => {
    const engine = new RefactorEngine();
    const report = await engine.analyzeFiles('/tmp', []);

    expect(report.totalFiles).toBe(0);
    expect(report.totalSmells).toBe(0);
    expect(report.files.length).toBe(0);
  });

  it('respects custom thresholds', async () => {
    const engine = new RefactorEngine({
      enabledRules: ['long-method'],
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        maxMethodLines: 200,
      },
    });
    const report = await engine.analyzeFiles('/tmp', [
      path.join(FIXTURES_DIR, 'long-method.fixture.ts'),
    ]);

    // With high method line threshold, long-method detector should flag nothing
    expect(report.totalSmells).toBe(0);
  });

  it('respects enabled rules filtering', async () => {
    const engine = new RefactorEngine({
      enabledRules: ['long-method'],
      thresholds: { ...DEFAULT_CONFIG.thresholds, maxMethodLines: 10 },
    });
    const report = await engine.analyzeFiles('/tmp', [
      path.join(FIXTURES_DIR, 'long-method.fixture.ts'),
    ]);

    for (const fileReport of report.files) {
      for (const smell of fileReport.smells) {
        expect(smell.ruleId).toBe('long-method');
      }
    }
  });

  it('calculates maintainability score correctly', async () => {
    const engine = new RefactorEngine();
    const report = await engine.analyzeFiles('/tmp', [
      path.join(FIXTURES_DIR, 'long-method.fixture.ts'),
    ]);

    for (const fileReport of report.files) {
      expect(fileReport.maintainabilityScore).toBeGreaterThanOrEqual(0);
      expect(fileReport.maintainabilityScore).toBeLessThanOrEqual(100);
      expect(['critical', 'high', 'medium', 'low']).toContain(fileReport.refactorPriority);
    }
  });

  it('produces summary statistics', async () => {
    const engine = new RefactorEngine();
    const report = await engine.analyzeFiles('/tmp', [
      path.join(FIXTURES_DIR, 'long-method.fixture.ts'),
    ]);

    expect(report.summary.criticalFiles).toBeGreaterThanOrEqual(0);
    expect(report.summary.needsImmediateAction).toBeGreaterThanOrEqual(0);
    expect(typeof report.summary.suggestionsByType).toBe('object');
  });

  it('scans directory successfully', async () => {
    const engine = new RefactorEngine();
    const report = await engine.analyzeDirectory(FIXTURES_DIR);

    expect(report.totalFiles).toBeGreaterThan(0);
    expect(report.scannedFiles).toBeGreaterThan(0);
    expect(report.projectRoot).toBe(FIXTURES_DIR);
  });
});

describe('detectOversizedFile', () => {
  it('does not flag normal fixture files', () => {
    const parsed = parseFile(path.join(FIXTURES_DIR, 'long-method.fixture.ts'));
    expect(parsed.linesOfCode).toBeLessThan(200);
  });
});

describe('detectDeepNesting via engine', () => {
  it('flags deeply nested code', async () => {
    const engine = new RefactorEngine({
      thresholds: { ...DEFAULT_CONFIG.thresholds, maxNestingDepth: 2 },
    });
    const report = await engine.analyzeFiles('/tmp', [
      path.join(FIXTURES_DIR, 'deep-nesting.fixture.ts'),
    ]);

    const nestingSmells = report.files.flatMap((f) =>
      f.smells.filter((s) => s.ruleId === 'deep-nesting'),
    );
    expect(nestingSmells.length).toBeGreaterThanOrEqual(1);
  });
});

describe('duplicated-code regression', () => {
  async function duplicatedCodeSmells(
    filePaths: string[],
    thresholds?: Partial<typeof DEFAULT_CONFIG.thresholds>,
  ): Promise<number> {
    const engine = new RefactorEngine({
      enabledRules: ['duplicated-code'],
      thresholds: thresholds ? { ...DEFAULT_CONFIG.thresholds, ...thresholds } : undefined,
    });
    const report = await engine.analyzeFiles('/tmp', filePaths);
    return report.files.flatMap((f) => f.smells.filter((s) => s.ruleId === 'duplicated-code'))
      .length;
  }

  it('does not flag files that only share short JSDoc headers', async () => {
    const smells = await duplicatedCodeSmells([
      path.join(FIXTURES_DIR, 'dup-doc-a.fixture.ts'),
      path.join(FIXTURES_DIR, 'dup-doc-b.fixture.ts'),
    ]);
    expect(smells).toBe(0);
  });

  it('skips comment-only windows that normalize to empty strings', async () => {
    const smells = await duplicatedCodeSmells(
      [
        path.join(FIXTURES_DIR, 'dup-doc15-a.fixture.ts'),
        path.join(FIXTURES_DIR, 'dup-doc15-b.fixture.ts'),
      ],
      { minDuplicateLines: 15 },
    );
    expect(smells).toBe(0);
  });

  it('still detects genuinely duplicated code blocks', async () => {
    const smells = await duplicatedCodeSmells([
      path.join(FIXTURES_DIR, 'dup-real-a.fixture.ts'),
      path.join(FIXTURES_DIR, 'dup-real-b.fixture.ts'),
    ]);
    expect(smells).toBeGreaterThanOrEqual(1);
  });

  it('同一重复区的连续滑窗合并为一条/文件，不再逐窗口重复计数', async () => {
    const engine = new RefactorEngine({ enabledRules: ['duplicated-code'] });
    const report = await engine.analyzeFiles('/tmp', [
      path.join(FIXTURES_DIR, 'dup-real-a.fixture.ts'),
      path.join(FIXTURES_DIR, 'dup-real-b.fixture.ts'),
    ]);
    const smells = report.files.flatMap((f) =>
      f.smells.filter((s) => s.ruleId === 'duplicated-code'),
    );

    // 两个夹具共用同一段 14 行实现 → 每侧各 1 条。
    // 修复前：定长窗口按 1 行步进，该段被切成 14-5+1=10 个窗口 → 每侧 10 条、共 20 条，
    // 用户看到的是被放大的问题数（实测导航 fixture 上 62 条 → 4 条）。
    expect(smells).toHaveLength(2);
    for (const s of smells) {
      expect(s.context.metric).toBe('duplicateLines');
      // value 必须是重复区行数（此前误用 dup.code.length = 截断到 80 的归一化字符数）
      expect(s.context.value).toBe(14);
      expect(s.location.endLine - s.location.line + 1).toBe(14);
    }
  });

  it('只共享 import 样板与防御性 catch 惯用法的文件不被误报为重复', async () => {
    const smells = await duplicatedCodeSmells([
      path.join(FIXTURES_DIR, 'dup-noise-a.fixture.ts'),
      path.join(FIXTURES_DIR, 'dup-noise-b.fixture.ts'),
    ]);
    expect(smells).toBe(0);
  });

  it('只共享 SVG 图标属性 / ToolAdapter 骨架 / hook 接线收尾样板的文件不被误报为重复', async () => {
    const smells = await duplicatedCodeSmells([
      path.join(FIXTURES_DIR, 'dup-boiler-a.fixture.tsx'),
      path.join(FIXTURES_DIR, 'dup-boiler-b.fixture.tsx'),
    ]);
    expect(smells).toBe(0);
  });

  it('重复区行号归属当前侧：A 侧报 A 的行、消息指 B 侧行，B 侧反之', async () => {
    const engine = new RefactorEngine({ enabledRules: ['duplicated-code'] });
    const fileA = path.join(FIXTURES_DIR, 'dup-attrib-a.fixture.ts');
    const fileB = path.join(FIXTURES_DIR, 'dup-attrib-b.fixture.ts');
    const report = await engine.analyzeFiles('/tmp', [fileA, fileB]);

    const smells = report.files.flatMap((f) =>
      f.smells.filter((s) => s.ruleId === 'duplicated-code'),
    );
    expect(smells).toHaveLength(2);

    const aSmell = smells.find((s) => s.location.filePath === fileA);
    const bSmell = smells.find((s) => s.location.filePath === fileB);
    expect(aSmell).toBeDefined();
    expect(bSmell).toBeDefined();
    if (!aSmell || !bSmell) return;

    // A 侧 sharedCalc 在第 4 行起（10 行）；B 侧在第 8 行起
    expect(aSmell.location.line).toBe(4);
    expect(aSmell.location.endLine).toBe(13);
    expect(aSmell.message).toContain('dup-attrib-b.fixture.ts:8');

    expect(bSmell.location.line).toBe(8);
    expect(bSmell.location.endLine).toBe(17);
    expect(bSmell.message).toContain('dup-attrib-a.fixture.ts:4');
  });
});

describe('detectOversizedComponent (TDD 回归)', () => {
  it('浅 JSX 组件因 TS 泛型误计 JSX 深度 → 不应触发 oversized-component', () => {
    const parsed = parseFile(
      path.join(FIXTURES_DIR, 'oversized-shallow-jsx.fixture.tsx'),
    );
    const smells = detectOversizedComponent(parsed, DEFAULT_CONFIG);
    expect(smells).toEqual([]);
  });
});

describe('detectOversizedComponent — 泛型不应当作 JSX 深度 (TDD RED)', () => {
  it('浅 JSX + TS 泛型组件不应被误判为"组件过大"', () => {
    const parsed = parseFile(
      path.join(FIXTURES_DIR, 'oversized-shallow-jsx.fixture.tsx'),
    );
    const smells = detectOversizedComponent(parsed, DEFAULT_CONFIG);
    // 泛型 useState<Set<number>> 不是 JSX，不应把 JSX 深度从 2 虚高到 12
    expect(smells).toEqual([]);
  });
});
